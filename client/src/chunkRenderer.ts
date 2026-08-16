import * as THREE from 'three';
import { CHUNK_SIZE } from '@game/shared';

const material = new THREE.MeshLambertMaterial({ vertexColors: true });

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

interface MeshResult {
  chunkX: number;
  chunkZ: number;
  version: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/**
 * Builds/updates one Three.js mesh per chunk from the greedy mesher's output,
 * run in a Web Worker (PLAN.md Phase 2) so remeshing never blocks a frame.
 *
 * Each chunk key tracks its latest requested version; a worker result for a
 * stale version (superseded by a newer edit before the first result came
 * back) is discarded rather than applied out of order.
 */
export class ChunkRenderer {
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly latestVersion = new Map<string, number>();
  private readonly worker: Worker;

  constructor(private readonly scene: THREE.Scene) {
    this.worker = new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<MeshResult>) => this.applyResult(event.data);
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

    let mesh = this.meshes.get(key);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      mesh.position.set(result.chunkX * CHUNK_SIZE, 0, result.chunkZ * CHUNK_SIZE);
      this.scene.add(mesh);
      this.meshes.set(key, mesh);
    } else {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
    }

    const geometry = mesh.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(result.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.worker.terminate();
  }
}
