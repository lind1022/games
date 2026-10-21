import * as THREE from 'three';
import { CHUNK_SIZE } from '@game/shared';
import { createBlockMaterial } from './blockMaterial.js';
import type { ChunkMeshData } from './mesh.js';

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

interface MeshResult {
  chunkX: number;
  chunkZ: number;
  version: number;
  opaque: ChunkMeshData;
  transparent: ChunkMeshData;
}

interface ChunkMeshes {
  opaque: THREE.Mesh;
  transparent: THREE.Mesh;
}

/**
 * Builds/updates two Three.js meshes per chunk (opaque + PLAN.md Phase 8's
 * transparent second pass — GLASS, WATER) from the greedy mesher's output,
 * run in a Web Worker (PLAN.md Phase 2) so remeshing never blocks a frame.
 *
 * Each chunk key tracks its latest requested version; a worker result for a
 * stale version (superseded by a newer edit before the first result came
 * back) is discarded rather than applied out of order.
 */
export class ChunkRenderer {
  private readonly meshes = new Map<string, ChunkMeshes>();
  private readonly latestVersion = new Map<string, number>();
  private readonly worker: Worker;
  private readonly opaqueMaterial: THREE.RawShaderMaterial;
  private readonly transparentMaterial: THREE.RawShaderMaterial;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly blockTextureArray: THREE.DataArrayTexture
  ) {
    this.opaqueMaterial = createBlockMaterial(blockTextureArray);
    this.transparentMaterial = createBlockMaterial(blockTextureArray, { transparent: true });
    this.worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<MeshResult>) => this.applyResult(event.data);
    // Previously unhandled: a worker-side exception (or a message that
    // fails structured-clone deserialization) produced no error anywhere
    // — the chunk just silently never arrives, with no console output, no
    // fallback, nothing. At full-world-load scale this reads as "stuck on
    // the sky-blue background forever," which is exactly the "pure blue
    // world" symptom this project has intermittently seen and never
    // conclusively root-caused (see HANDOFF.md). This doesn't fix
    // whatever the underlying failure is, but it stops it from being
    // invisible, which is the CLAUDE.md §7 problem with leaving it as-is
    // regardless of whether it's the actual cause here.
    this.worker.onerror = (event) => {
      console.error('[chunkRenderer] mesh worker error:', event.message, event);
    };
    this.worker.onmessageerror = (event) => {
      console.error('[chunkRenderer] mesh worker message could not be deserialized:', event);
    };
  }

  updateChunk(chunkX: number, chunkZ: number, blocks: Uint8Array): void {
    const key = chunkKey(chunkX, chunkZ);
    const version = (this.latestVersion.get(key) ?? 0) + 1;
    this.latestVersion.set(key, version);

    // Transferring detaches the buffer from the sender, and `blocks` is the
    // live chunk data ClientWorld uses for collision/raycasting — clone
    // before handing ownership to the worker so that store stays intact.
    const copy = blocks.slice();
    this.worker.postMessage({ chunkX, chunkZ, version, blocks: copy }, [copy.buffer]);
  }

  private applyResult(result: MeshResult): void {
    const key = chunkKey(result.chunkX, result.chunkZ);
    if (this.latestVersion.get(key) !== result.version) return; // superseded — discard

    let entry = this.meshes.get(key);
    if (!entry) {
      const opaque = new THREE.Mesh(new THREE.BufferGeometry(), this.opaqueMaterial);
      const transparent = new THREE.Mesh(new THREE.BufferGeometry(), this.transparentMaterial);
      const position: [number, number, number] = [result.chunkX * CHUNK_SIZE, 0, result.chunkZ * CHUNK_SIZE];
      opaque.position.set(...position);
      transparent.position.set(...position);
      this.scene.add(opaque, transparent);
      entry = { opaque, transparent };
      this.meshes.set(key, entry);
    }

    setGeometry(entry.opaque, result.opaque);
    setGeometry(entry.transparent, result.transparent);
  }

  dispose(): void {
    this.worker.terminate();
    for (const { opaque, transparent } of this.meshes.values()) {
      opaque.geometry.dispose();
      transparent.geometry.dispose();
      this.scene.remove(opaque, transparent);
    }
    this.meshes.clear();
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
    // Not reached via material.dispose(): the texture lives in a shader
    // uniform (uniforms.map.value), not material.map, which is the only
    // texture reference three.js's own material disposal knows to follow.
    this.blockTextureArray.dispose();
  }
}

function setGeometry(mesh: THREE.Mesh, data: ChunkMeshData): void {
  mesh.geometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setAttribute('layer', new THREE.BufferAttribute(data.layers, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  mesh.geometry = geometry;
}
