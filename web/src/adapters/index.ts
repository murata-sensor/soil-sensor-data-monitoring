import { NormalizedRow } from "./normalized";
import * as m5stack from "./m5stack";
import * as mechatrax from "./mechatrax";
import * as pcSerial from "./pcSerial";
import * as remoteFtp from "./remoteFtp";

export type SchemaType =
  | typeof m5stack.KEY
  | typeof mechatrax.KEY
  | typeof pcSerial.KEY
  | typeof remoteFtp.KEY;

const ADAPTERS: Record<SchemaType, { toNormalized(v: string[][]): NormalizedRow[] }> = {
  [m5stack.KEY]: m5stack,
  [mechatrax.KEY]: mechatrax,
  [pcSerial.KEY]: pcSerial,
  [remoteFtp.KEY]: remoteFtp,
};

export function isSchemaType(s: string): s is SchemaType {
  return s in ADAPTERS;
}

export function toNormalized(schemaType: SchemaType, values: string[][]): NormalizedRow[] {
  return ADAPTERS[schemaType].toNormalized(values);
}

export { m5stack, mechatrax, pcSerial, remoteFtp };
export type { NormalizedRow };
