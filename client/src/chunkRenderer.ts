import * as THREE from 'three';
import { CHUNK_SIZE } from '@game/shared';
import { meshChunk } from './mesh.js';
import { blockColor } from './colors.js';

const material = new THREE.MeshLambertMaterial({ vertexColors: true });

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

/** Builds/updates one Three.js mesh per chunk from the greedy mesher's output. */
export class ChunkRenderer {
  private readonly meshes = new Map<string, THREE.Mesh>();

  constructor(private readonly scene: THREE.Scene) {}

  updateChunk(chunkX: number, chunkZ: number, blocks: Uint8Array): void {
    const key = chunkKey(chunkX, chunkZ);
    const data = meshChunk(blocks, blockColor);

    let mesh = this.meshes.get(key);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      mesh.position.set(chunkX * CHUNK_SIZE, 0, chunkZ * CHUNK_SIZE);
      this.scene.add(mesh);
      this.meshes.set(key, mesh);
    } else {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
    }

    const geometry = mesh.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
  }
}
