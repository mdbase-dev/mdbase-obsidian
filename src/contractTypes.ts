/** A record contract as the type workbench reads it from `_contracts/`. */
export type JsonObject = Record<string, unknown>;

export interface CollectionContractDescriptor {
  contract_type: "record";
  id: string;
  version: string;
  /** Digest of the resolved contract schemas and metadata. */
  digest: string;
  /** Resolved portable record-view schema. */
  schema: JsonObject;
  /** Resolved implementation-binding schema, when the contract declares one. */
  binding_schema?: JsonObject;
  /** Every type implementing this exact contract, sorted by type name. */
  implementations: Array<{ type_name: string; type_version: number; type_path?: string; digest: string; fields: Record<string, string> }>;
}
