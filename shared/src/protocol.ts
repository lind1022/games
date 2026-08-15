/**
 * WebSocket protocol schemas — locked contracts #8-9 (see PLAN.md §1).
 *
 * PROTOCOL_VERSION bumps on any breaking change to these shapes; the
 * server should reject a client whose handshake protocolVersion doesn't
 * match with a friendly "please refresh" error rather than failing
 * silently or misparsing.
 */

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

const chunkDataSchema = z.object({
  chunkX: z.number().int(),
  chunkZ: z.number().int(),
  formatVersion: z.number().int(),
  /** Base64-encoded RLE chunk blob — see shared/rle.ts. */
  data: z.string(),
});
export type ChunkData = z.infer<typeof chunkDataSchema>;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

const joinMessageSchema = z.object({
  type: z.literal('join'),
  protocolVersion: z.number().int(),
  /**
   * Join code (contract #9): present from day one, but NOT validated
   * against join_codes until Phase 4. Pre-Phase-4 servers accept any
   * non-empty string here and use `name` as the dev-stub display name.
   */
  code: z.string().min(1),
  name: z.string().min(1).max(32).optional(),
});
export type JoinMessage = z.infer<typeof joinMessageSchema>;

const blockUpdateIntentSchema = z.object({
  type: z.literal('block-update-intent'),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  blockId: z.number().int().min(0).max(255),
});
export type BlockUpdateIntent = z.infer<typeof blockUpdateIntentSchema>;

const playerMoveSchema = z.object({
  type: z.literal('player-move'),
  position: vec3Schema,
  yaw: z.number(),
  pitch: z.number(),
});
export type PlayerMove = z.infer<typeof playerMoveSchema>;

const chatMessageInSchema = z.object({
  type: z.literal('chat-message'),
  text: z.string().min(1).max(200),
});
export type ChatMessageIn = z.infer<typeof chatMessageInSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  blockUpdateIntentSchema,
  playerMoveSchema,
  chatMessageInSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

const worldStateSchema = z.object({
  type: z.literal('world-state'),
  chunks: z.array(chunkDataSchema),
  spawn: vec3Schema,
  selfId: z.string(),
  selfName: z.string(),
});
export type WorldState = z.infer<typeof worldStateSchema>;

const blockUpdateSchema = z.object({
  type: z.literal('block-update'),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  blockId: z.number().int().min(0).max(255),
  by: z.string(),
});
export type BlockUpdate = z.infer<typeof blockUpdateSchema>;

const playerStateSchema = z.object({
  type: z.literal('player-state'),
  id: z.string(),
  name: z.string(),
  position: vec3Schema,
  yaw: z.number(),
  pitch: z.number(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;

const playerJoinSchema = z.object({
  type: z.literal('player-join'),
  id: z.string(),
  name: z.string(),
});
export type PlayerJoin = z.infer<typeof playerJoinSchema>;

const playerLeaveSchema = z.object({
  type: z.literal('player-leave'),
  id: z.string(),
});
export type PlayerLeave = z.infer<typeof playerLeaveSchema>;

const chatMessageOutSchema = z.object({
  type: z.literal('chat-message'),
  from: z.string(),
  text: z.string(),
});
export type ChatMessageOut = z.infer<typeof chatMessageOutSchema>;

const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  worldStateSchema,
  blockUpdateSchema,
  playerStateSchema,
  playerJoinSchema,
  playerLeaveSchema,
  chatMessageOutSchema,
  errorMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
