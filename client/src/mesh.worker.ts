import { meshChunk } from './mesh.js';
import { blockColor } from './colors.js';

/**
 * Web Worker wrapper around the pure `meshChunk` function (PLAN.md C3 / Phase 2:
 * meshing was written as a pure function specifically so this migration is just
 * a message-passing shim, not a rewrite). Runs off the main thread so remeshing
 * a chunk never stalls a frame.
 *
 * Typed narrowly against `self` instead of pulling in the full "webworker" lib —
 * this file's tsconfig also compiles main-thread DOM code, and the two lib sets
 * disagree on `postMessage`'s signature.
 */

interface MeshRequest {
  chunkX: number;
  chunkZ: number;
  version: number;
  blocks: Uint8Array;
}

interface MeshResponse {
  chunkX: number;
  chunkZ: number;
  version: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<MeshRequest>) => void) | null;
  postMessage(message: MeshResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { chunkX, chunkZ, version, blocks } = event.data;
  const mesh = meshChunk(blocks, blockColor);
  scope.postMessage(
    { chunkX, chunkZ, version, ...mesh },
    [mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer]
  );
};
