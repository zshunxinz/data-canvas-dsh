import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canvasToolDefinitions } from '../lib/tools.js'

/**
 * Wire-schema conformance.
 *
 * Regression cover for a real defect: the tool definitions were first written
 * in `defineTool` DSL shape (`required: true` inside a property, `type: 'json'`
 * for free-form values) but registered through the raw `ctx.tools.register()`,
 * which passes `parameters` through to the provider verbatim. Providers reject
 * that: JSON Schema wants `required` as an array of names on the *object*, and
 * has no `json` type.
 *
 * Symptom it produced:
 *   Invalid schema for function 'canvas_add_card':
 *   {"type":"string","required":true,...} is not valid under any of the
 *   schemas listed in the 'anyOf' keyword
 *
 * These assertions pin the shape so it cannot regress.
 */

const tools = canvasToolDefinitions(() => '/tmp/unused')

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

test('every tool declares parameters as a plain JSON Schema object', () => {
  for (const tool of tools) {
    const params = tool.parameters
    assert.equal(typeof params, 'object', `${tool.name}: parameters must be an object`)
    assert.notEqual(params, null, `${tool.name}: parameters must not be null`)
    if (Object.keys(params).length === 0) continue // no-argument tool
    assert.equal(params.type, 'object', `${tool.name}: top-level type must be "object"`)
    assert.equal(typeof params.properties, 'object', `${tool.name}: needs a properties map`)
  }
})

test('no property carries a boolean `required` (the exact defect)', () => {
  for (const tool of tools) {
    const properties = tool.parameters?.properties ?? {}
    for (const [key, spec] of Object.entries(properties)) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(spec, 'required'),
        false,
        `${tool.name}.${key}: property-level "required" is invalid JSON Schema and is rejected by providers`,
      )
    }
  }
})

test('required-ness lives in an object-level array of names', () => {
  for (const tool of tools) {
    const params = tool.parameters ?? {}
    if (!params.required) continue
    assert.ok(Array.isArray(params.required), `${tool.name}: required must be an array`)
    for (const name of params.required) {
      assert.equal(typeof name, 'string', `${tool.name}: required entries must be strings`)
      assert.ok(
        Object.prototype.hasOwnProperty.call(params.properties ?? {}, name),
        `${tool.name}: required names a property that does not exist: ${name}`,
      )
    }
  }
})

test('every property uses a valid JSON Schema type', () => {
  for (const tool of tools) {
    for (const [key, spec] of Object.entries(tool.parameters?.properties ?? {})) {
      if (spec.type === undefined) {
        // an annotation-only node is allowed: it means "unconstrained value"
        assert.ok(spec.description, `${tool.name}.${key}: a typeless node must at least describe itself`)
        continue
      }
      assert.ok(
        JSON_SCHEMA_TYPES.has(spec.type),
        `${tool.name}.${key}: "json" is not a JSON Schema type (got ${spec.type})`,
      )
    }
  }
})

test('free-form object properties are declared as object type', () => {
  for (const tool of tools) {
    for (const [key, spec] of Object.entries(tool.parameters?.properties ?? {})) {
      if (spec.type === undefined) continue
      if (spec.type !== 'object') continue
      assert.equal(
        typeof spec.additionalProperties,
        'boolean',
        `${tool.name}.${key}: an object node should state additionalProperties explicitly`,
      )
    }
  }
})

test('the previously failing tool now declares a valid enum for its type field', () => {
  const addCard = tools.find(t => t.name === 'canvas_add_card')
  assert.ok(addCard, 'canvas_add_card must exist')
  const typeSpec = addCard.parameters.properties.type
  assert.equal(typeSpec.type, 'string')
  assert.deepEqual(typeSpec.enum, ['chart', 'table', 'kpi', 'text', 'code'])
  assert.deepEqual(addCard.parameters.required.sort(), ['canvas_id', 'title', 'type'])
})

test('every declared required property is one the implementation actually reads', () => {
  // Guards against marking an optional field required (or vice versa) in a way
  // that would make the tool unusable for the model.
  for (const tool of tools) {
    const required = tool.parameters?.required ?? []
    const names = Object.keys(tool.parameters?.properties ?? {})
    for (const name of required) {
      assert.ok(names.includes(name), `${tool.name}: required ${name} missing from properties`)
    }
  }
})

test('the whole parameter tree is JSON-serialisable (it is sent over the wire)', () => {
  for (const tool of tools) {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(tool.parameters ?? {})))
  }
})

test('no tool parameter name collides with a JSON Schema keyword', () => {
  const reserved = new Set(['type', 'properties', 'required', 'enum', 'items', 'additionalProperties', 'description'])
  for (const tool of tools) {
    if (tool.parameters?.type !== 'object') continue
    // "type" is a legitimate *property name* here (the card type), but it must
    // not be confused with the schema keyword — assert it lives under properties.
    assert.ok(tool.parameters.properties, `${tool.name}: schema keywords must not be merged into properties`)
    for (const key of Object.keys(tool.parameters)) {
      if (key === 'properties') continue
      assert.ok(reserved.has(key), `${tool.name}: unexpected top-level key ${key}`)
    }
  }
})
