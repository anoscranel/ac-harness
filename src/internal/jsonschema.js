// src/internal/jsonschema.js — hand-rolled JSON-Schema subset validator.
// Checks EXACTLY the subset enumerated in specs/plugin-manifest.md:
//   type, required, properties, additionalProperties, items, enum, pattern,
//   minLength, maxLength, minItems, format:"uri" (annotation-only).
// Unknown or deeper keywords are a warning, never a failure.
// Used by the plugin-manifest loader and by tool-arg validation.

const KNOWN_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", // annotation keywords, ignored
  "type", "required", "properties", "additionalProperties",
  "items", "enum", "pattern", "minLength", "maxLength", "minItems", "format",
]);

const TYPES = new Set(["object", "array", "string", "number", "boolean", "integer", "null"]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // object | string | number | boolean | undefined
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === "integer") return actual === "number" && Number.isInteger(value);
  return actual === expected;
}

/**
 * Validate `value` against `schema` (subset above).
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validate(value, schema, path = "$") {
  const errors = [];
  const warnings = [];

  function walk(v, s, p) {
    if (s === true || s === undefined) return;
    if (s === false) {
      errors.push(`${p}: not allowed (schema false)`);
      return;
    }
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      warnings.push(`${p}: non-object schema ignored`);
      return;
    }
    for (const k of Object.keys(s)) {
      if (!KNOWN_KEYWORDS.has(k)) warnings.push(`${p}: unknown keyword "${k}" ignored`);
    }

    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum)) {
        warnings.push(`${p}: enum is not an array, ignored`);
      } else if (!s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
        errors.push(`${p}: value not in enum [${s.enum.map((e) => JSON.stringify(e)).join(", ")}]`);
      }
    }

    if (s.type !== undefined) {
      const expected = Array.isArray(s.type) ? s.type : [s.type];
      for (const t of expected) {
        if (!TYPES.has(t)) warnings.push(`${p}: unknown type "${t}"`);
      }
      if (!expected.some((t) => typeMatches(v, t))) {
        errors.push(`${p}: expected type ${expected.join("|")}, got ${typeOf(v)}`);
        return; // deeper checks are meaningless after a type failure
      }
    }

    if (typeof v === "string") {
      if (s.minLength !== undefined && v.length < s.minLength) {
        errors.push(`${p}: string shorter than minLength ${s.minLength}`);
      }
      if (s.maxLength !== undefined && v.length > s.maxLength) {
        errors.push(`${p}: string longer than maxLength ${s.maxLength}`);
      }
      if (s.pattern !== undefined) {
        try {
          if (!new RegExp(s.pattern).test(v)) errors.push(`${p}: does not match pattern ${s.pattern}`);
        } catch {
          warnings.push(`${p}: invalid pattern "${s.pattern}" ignored`);
        }
      }
      if (s.format === "uri") {
        // Annotation-only per spec: stored, never rejected.
        warnings.push(`${p}: format "uri" is annotation-only, not enforced`);
      }
    }

    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) {
        errors.push(`${p}: fewer than minItems ${s.minItems}`);
      }
      if (s.items !== undefined) {
        v.forEach((item, i) => walk(item, s.items, `${p}[${i}]`));
      }
    }

    if (typeOf(v) === "object") {
      if (s.required !== undefined) {
        if (!Array.isArray(s.required)) {
          warnings.push(`${p}: required is not an array, ignored`);
        } else {
          for (const key of s.required) {
            if (!(key in v)) errors.push(`${p}: missing required key "${key}"`);
          }
        }
      }
      const props = s.properties && typeof s.properties === "object" ? s.properties : {};
      for (const [key, sub] of Object.entries(props)) {
        if (key in v) walk(v[key], sub, `${p}.${key}`);
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(v)) {
          if (!(key in props)) errors.push(`${p}: additionalProperty "${key}" not allowed`);
        }
      } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
        for (const key of Object.keys(v)) {
          if (!(key in props)) walk(v[key], s.additionalProperties, `${p}.${key}`);
        }
      }
    }
  }

  walk(value, schema, path);
  return { ok: errors.length === 0, errors, warnings };
}
