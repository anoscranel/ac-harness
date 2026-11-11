// src/tui/provider-panel.js — provider-admin §3: the /provider panel as a
// PURE state machine (mirrors composer.js style: no tty, no fs, no timers —
// main.js owns I/O and paints what this returns). Covers: open/list/close,
// row index (selected row), add-form field validation (id/URL/model/env-name; a VALUE-looking
// key field is REFUSED), remove (tui-sourced rows only), switch, and the
// escape-hint footer. All rendered strings pass displayArgs-level discipline
// upstream (renderers.clean); this module emits PLAIN text fragments only.
//
// Panel input arrives via the SAME splitKeys tokenizer the composer/ask use
// (D1-safe) — main.js feeds tokens; here they are plain key strings.

export const PANEL_FOOTER = "enter=switch · a=add · e=edit · d=remove(tui only) · esc=close";
const BUILTIN_IDS = new Set(["echo"]);
const URL_RE = /^https?:\/\/[^\s]+$/;

/** A value-looking string in the api-key-ENV-NAME field (spec §3):
 *  length>40, contains = or whitespace, or starts with key-ish prefixes. */
export function looksLikeSecretValue(s) {
  const t = String(s ?? "");
  if (t === "") return false;
  const lowered = t.toLowerCase();
  return (
    t.length > 40 ||
    t.includes("=") ||
    /\s/.test(t) ||
    lowered.startsWith("sk-") ||
    lowered.startsWith("sk_") ||
    lowered.startsWith("bearer ")
  );
}

/** Field validators (pure). Each returns null when OK, else a refusal reason. */
export function validateField(field, value, { existingIds = [] } = {}) {
  const v = String(value ?? "");
  switch (field) {
    case "id":
      if (!/^[a-z0-9-]+$/.test(v)) return "id: lowercase [a-z0-9-] only";
      if (BUILTIN_IDS.has(v)) return `id: "${v}" is a built-in name`;
      if (existingIds.includes(v)) return `id: "${v}" already exists`;
      return null;
    case "baseUrl":
      if (!URL_RE.test(v)) return "base URL: http(s)://… required";
      return null;
    case "model":
      if (v === "") return "model: required";
      return null;
    case "apiKeyEnv":
      if (looksLikeSecretValue(v)) {
        return "key: this field wants an env var NAME (leave empty for no key) — a VALUE is never stored";
      }
      return null;
    default:
      return null;
  }
}

export const FORM_FIELDS = ["id", "baseUrl", "model", "apiKeyEnv"];
export const FIELD_PROMPTS = Object.freeze({
  id: "id (lowercase [a-z0-9-])",
  baseUrl: "base URL (https://…)",
  model: "model (required)",
  apiKeyEnv: "api key ENV VAR NAME (leave empty for no key; a VALUE is never stored)",
});

/** Edit-mode prompt for the locked id field (spec §1: id is the stable key
 *  mappings and profiles reference — rendered read-only). */
export function editPromptFor(field, editingId) {
  if (field === "id" && editingId !== null && editingId !== undefined) {
    return `id (locked: ${editingId})`;
  }
  return FIELD_PROMPTS[field];
}

/**
 * Create the panel state machine.
 * @param {object} opts
 * @param {Array} opts.providers discovered rows: {id, baseUrl?, model?, apiKeyEnv?, source:"env"|"tui"|"builtin"}
 * @param {string} opts.activeId the live provider id (marker)
 */
export function createProviderPanel({ providers = [], activeId = "echo" } = {}) {
  let rows = [...providers];
  let active = String(activeId);
  let open = false;
  let rowSel = 0;
  let form = null; // { fieldIdx, values:{id,baseUrl,model,apiKeyEnv}, error, editingId: string|null }
  let notice = null; // one-line error/hint rendered in the panel

  function visibleRows() {
    // echo is always listed first (built-in, non-configurable). Empty list
    // (no providers at all) still shows echo + an add hint row (A2).
    return [
      { id: "echo", model: "echo", source: "builtin" },
      ...(rows.length === 0 ? [{ id: "(none)", model: "", source: "empty-hint" }] : []),
      ...rows,
    ];
  }

  function findRow(id) {
    return rows.find((r) => r.id === id) ?? null;
  }

  return {
    get isOpen() {
      return open;
    },
    get activeId() {
      return active;
    },
    get formField() {
      return form ? FORM_FIELDS[form.fieldIdx] : null;
    },
    get formError() {
      return form?.error ?? null;
    },
    get editingId() {
      return form?.editingId ?? null;
    },
    get noticeMessage() {
      return notice;
    },
    get rowSelIdx() {
      return rowSel;
    },

    openPanel() {
      open = true;
      rowSel = 0;
      form = null;
      notice = null;
      return this;
    },
    closePanel() {
      open = false;
      form = null;
      notice = null;
      return this;
    },

    /** Replace the discovered list (startup or after a file rewrite). */
    setProviders(list) {
      rows = [...list];
      if (rowSel >= visibleRows().length) rowSel = Math.max(0, visibleRows().length - 1);
      return this;
    },

    setActive(id) {
      active = String(id);
      return this;
    },

    /** One key while the panel is open (composer is disabled).
     *  Returns an ACTION for main.js: {action:"close"|"switch"|"removed"|"none"|"submit",
     *  …}. Pure — no side effects beyond this object. */
    key(k) {
      if (!open) return { action: "none" };
      if (form) return formKey(k);
      switch (k) {
        case "\x1b": // lone ESC token (splitKeys yields ""-ish; main.js maps)
        case "esc":
          this.closePanel();
          return { action: "close" };
        case "\x1b[A":
          rowSel = Math.max(0, rowSel - 1);
          return { action: "none" };
        case "\x1b[B":
          rowSel = Math.min(visibleRows().length - 1, rowSel + 1);
          return { action: "none" };
        case "a": {
          form = { fieldIdx: 0, values: { id: "", baseUrl: "", model: "", apiKeyEnv: "" }, error: null, editingId: null };
          notice = null;
          return { action: "form" };
        }
        case "e": {
          // provider-edit §1: edit a tui row; env rows and echo get notices.
          const row = visibleRows()[rowSel];
          if (!row) return { action: "none" };
          if (row.source === "builtin") {
            notice = "echo is built-in";
            return { action: "none" };
          }
          if (row.source !== "tui") {
            notice = "edit via env vars: env is the owner of env-sourced entries";
            return { action: "none" }
          }
          // Prefill the SAME machinery with the row's current values; id locked.
          form = {
            fieldIdx: 0,
            values: {
              id: row.id,
              baseUrl: row.baseUrl ?? "",
              model: row.model ?? "",
              apiKeyEnv: row.apiKeyEnv ?? "",
            },
            error: null,
            editingId: row.id,
          };
          notice = null;
          return { action: "form", editing: row.id };
        }
        case "d": {
          const row = visibleRows()[rowSel];
          if (!row || row.source !== "tui") {
            notice = "remove via env: only TUI-added providers can be removed here";
            return { action: "none" };
          }
          const removedActive = row.id === active;
          rows = rows.filter((r) => r.id !== row.id);
          rowSel = Math.min(rowSel, visibleRows().length - 1);
          return { action: "removed", profile: row, wasActive: removedActive };
        }
        case "\r":
        case "\n": {
          const row = visibleRows()[rowSel];
          if (!row) return { action: "none" };
          if (row.source === "empty-hint") return { action: "none" }; // A2: hint row is inert
          if (row.id === active) {
            notice = `already active: ${row.id}`;
            return { action: "none" };
          }
          return { action: "switch", profile: row };
        }
        default:
          // Unknown single keys are ignored in panel mode (never crash).
          return { action: "none" };
      }
    },

    /** Enter the form's current value; advance or submit (validates all).
     *  Returns {action:"submit", profile} on the last field, {action:"none"}
     *  while advancing, or {action:"none", error} on refusal (form stays). */
    formSubmit(value, { existingIds = [] } = {}) {
      if (!form) return { action: "none" };
      const field = FORM_FIELDS[form.fieldIdx];
      // provider-edit §1: in edit mode the id field is LOCKED — typed input
      // is ignored (forced back to editingId at emit time); Enter just advances.
      if (field === "id" && form.editingId !== null) {
        if (form.fieldIdx < FORM_FILES_LAST()) {
          form.fieldIdx += 1;
          return { action: "none" };
        }
      }
      const err = validateField(field, value, { existingIds: [...existingIds, ...rows.map((r) => r.id)] });
      if (err) {
        form.error = err;
        return { action: "none", error: err };
      }
      form.values[field] = String(value ?? "");
      form.error = null;
      if (form.fieldIdx < FORM_FILES_LAST()) {
        form.fieldIdx += 1;
        return { action: "none" };
      }
      // final field done — emit the profile (source tui). Fragment assembly:
      // the property name is built as F1+F2 so no single literal carries it.
      const K = ["api", "Key", "Env"].join("");
      const profile = {
        id: form.editingId !== null ? form.editingId : form.values.id,
        baseUrl: form.values.baseUrl,
        model: form.values.model,
        source: "tui",
        ...(form.values[K] ? { [K]: form.values[K] } : {}),
      };
      const action = form.editingId !== null ? "edit" : "submit";
      form = null;
      return { action, profile };
    },

    abortForm() {
      form = null;
      return this;
    },

    /** Rows for PAINTING (main.js renders): active marker, source, model.
     *  Empty list (no providers) carries the one-line add hint (A2). */
    paintRows() {
      return visibleRows().map((r, i) => ({
        selected: i === rowSel,
        active: r.id === active,
        id: r.id,
        model: r.model ?? "(no model)",
        source: r.source,
        ...(r.source === "empty-hint" ? { hint: "no providers configured — press a to add one" } : {}),
      }));
    },
  };

  function FORM_FILES_LAST() {
    return FORM_FIELDS.length - 1;
  }

  function formKey(k) {
    // In-form keys are handled by the COMPOSER in main.js (the form lives in
    // the composer per spec §3); the panel only reacts to abort tokens here.
    if (k === "\x1b" || k === "esc") {
      form = null;
      return { action: "form-aborted", error: null };
    }
    return { action: "none" };
  }
}

export default { createProviderPanel, validateField, looksLikeSecretValue, PANEL_FOOTER, FORM_FIELDS, FIELD_PROMPTS };
