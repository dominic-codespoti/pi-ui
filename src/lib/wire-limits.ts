/** Shared payload limits used by server wire bounding and extension UI rendering. */

/** Per-block character cap for history payloads (~20k tokens). */
export const MAX_WIRE_BLOCK_CHARS = 80_000;
export const MIN_WIRE_BLOCK_CHARS = 512;
/** Per-rendered-field cap; extension HTML is derived and can be regenerated. */
export const MAX_WIRE_AUX_CHARS = 80_000;
/** Combined cap for rendered extension HTML and parsed extension trees. */
export const MAX_WIRE_AUX_TOTAL_CHARS = 256_000;
/** Oversized base64 images are omitted rather than sent as invalid prefixes. */
export const MAX_WIRE_IMAGE_CHARS = 256_000;
/** Tool output beyond this is fetched when the user expands its collapsed row. */
export const MAX_WIRE_TOOL_OUTPUT_CHARS = 2_000;
