import type { CollectionContractDescriptor, JsonObject } from "./contractTypes";
import { schemaFromV03Fields } from "./mdbaseCore";
import type {
  TypeEditorContractImplementation,
  TypeEditorModel,
} from "./typeEditorTypes";

export interface ContractField {
  name: string;
  reference: string;
  required: boolean;
  description?: string;
  schema: JsonObject;
}

export interface TypeContractField {
  label: string;
  reference: string;
  required: boolean;
  type: string;
  schema: JsonObject;
}

export type MappingLevel = "valid" | "warning" | "error" | "unmapped";

export interface MappingAssessment {
  level: MappingLevel;
  label: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function contractKey(contract: Pick<CollectionContractDescriptor, "id" | "version">): string {
  return `${contract.id}@${contract.version}`;
}

export function contractFields(contract: CollectionContractDescriptor): ContractField[] {
  const schema = isRecord(contract.schema) ? contract.schema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties)
    .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
    .map(([name, property]) => ({
      name,
      reference: name,
      required: required.has(name),
      schema: property,
      ...(typeof property.description === "string" ? { description: property.description } : {}),
    }));
}

export function typeFieldsForModel(model: TypeEditorModel): TypeContractField[] {
  const fieldRecord = Object.fromEntries(model.fields.map((field) => [field.name, field.definition]));
  const schema = schemaFromV03Fields(fieldRecord);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties)
    .filter((entry): entry is [string, JsonObject] => isRecord(entry[1]))
    .map(([name, property]) => ({
      label: name,
      reference: name,
      required: required.has(name),
      type: schemaType(property),
      schema: property,
    }));
}

export function mappingForContractField(
  implementation: TypeEditorContractImplementation,
  field: ContractField,
): string {
  return implementation.fields[field.reference] ?? implementation.fields[field.name] ?? "";
}

export function assessMapping(field: ContractField, typeField?: TypeContractField): MappingAssessment {
  if (!typeField) {
    return field.required
      ? { level: "error", label: "Required", message: `Map required contract field ${field.reference}.` }
      : { level: "unmapped", label: "Not exposed", message: "This optional contract field is not exposed." };
  }
  const contractType = schemaType(field.schema);
  if (!compatibleTypes(contractType, typeField.type)) {
    return {
      level: "error",
      label: "Incompatible",
      message: `${typeField.reference} is ${typeField.type}, but the contract expects ${contractType}.`,
    };
  }
  if (field.required && !typeField.required) {
    return {
      level: "warning",
      label: "Review",
      message: `${typeField.reference} is optional in this type, so the contract value may be absent.`,
    };
  }
  return { level: "valid", label: "Ready", message: "This field satisfies the contract shape." };
}

export function addImplementation(model: TypeEditorModel, contract: CollectionContractDescriptor): void {
  if (model.implementations.some((implementation) =>
    implementation.contract === contract.id && implementation.version === contract.version)) {
    throw new Error(`${contract.id} ${contract.version} is already implemented.`);
  }
  const typeFields = typeFieldsForModel(model);
  const fields = Object.fromEntries(contractFields(contract).flatMap((field) => {
    const match = typeFields.find((candidate) =>
      candidate.reference.toLowerCase() === field.reference.toLowerCase()
      && compatibleTypes(schemaType(field.schema), candidate.type));
    return match ? [[field.reference, match.reference]] : [];
  }));
  model.implementations.push({ contract: contract.id, version: contract.version, fields });
}

export function removeImplementation(model: TypeEditorModel, contract: string, version: string): void {
  model.implementations = model.implementations.filter((implementation) =>
    implementation.contract !== contract || implementation.version !== version);
}

export function setFieldMapping(
  implementation: TypeEditorContractImplementation,
  contractField: string,
  typeField?: string,
): void {
  if (typeField) implementation.fields[contractField] = typeField;
  else delete implementation.fields[contractField];
}

export function setBinding(
  implementation: TypeEditorContractImplementation,
  value: Record<string, unknown>,
): void {
  implementation.binding = Object.keys(value).length ? clone(value) : undefined;
}

export function schemaInitialValue(schema: JsonObject | undefined): unknown {
  if (!schema) return "";
  if (Array.isArray(schema.enum) && schema.enum.length) return clone(schema.enum[0]);
  const type = schemaType(schema);
  if (type === "object") {
    const result: Record<string, unknown> = {};
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    for (const [name, child] of Object.entries(properties)) {
      if (required.has(name) && isRecord(child)) result[name] = schemaInitialValue(child);
    }
    return result;
  }
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  return "";
}

export function schemaType(schema: JsonObject): string {
  if ("const" in schema) return typeof schema.const;
  if (Array.isArray(schema.type)) return String(schema.type.find((value) => value !== "null") ?? schema.type[0] ?? "string");
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum)) return "string";
  if (isRecord(schema.properties) || isRecord(schema.additionalProperties)) return "object";
  return "any";
}

export function schemaTypeLabel(schema: JsonObject): string {
  const type = schemaType(schema);
  return type === "array" ? "List" : type === "boolean" ? "Boolean" : type === "integer" ? "Integer" : type === "number" ? "Number" : type === "object" ? "Object" : type === "any" ? "Any value" : "Text";
}

function compatibleTypes(contractType: string, typeType: string): boolean {
  if (contractType === "any" || typeType === "any") return true;
  if (contractType === typeType) return true;
  return contractType === "number" && typeType === "integer";
}
