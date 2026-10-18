// Shared by sites.test.js (the rollout guide's policy files) and docs-layout.test.js (the private sample kit).
// A small, hand-rolled JSON Schema check: object/string/boolean/array, enum, properties, additionalProperties,
// items. Enough to prove a policy fits extension/managed_schema.json without a new dependency. Returns a list of
// problems; empty means it fits.
function schemaProblems(schema, value, where = "policy") {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && schema.type !== type) return [`${where}: expected ${schema.type}, got ${type}`];
  const problems = [];
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${where}: "${value}" isn't one of ${schema.enum}`);
  if (type === "object") {
    for (const [key, v] of Object.entries(value)) {
      const sub =
        schema.properties?.[key] ?? (schema.additionalProperties !== true ? schema.additionalProperties : null);
      if (!sub) problems.push(`${where}.${key}: not in the schema`);
      else problems.push(...schemaProblems(sub, v, `${where}.${key}`));
    }
  }
  if (type === "array" && schema.items) {
    value.forEach((v, i) => problems.push(...schemaProblems(schema.items, v, `${where}[${i}]`)));
  }
  return problems;
}

module.exports = { schemaProblems };
