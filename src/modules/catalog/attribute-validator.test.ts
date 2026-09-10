import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import {
  buildAttributeValidator,
  validateAndProject,
  type AttributeInput,
} from './attribute-validator.js';
import { attribute, attributeSet, options } from './test-fixtures.js';
import type { EffectiveAttributeSet } from './effective-attributes.js';

const project = (input: AttributeInput, set: EffectiveAttributeSet) =>
  validateAndProject(input, set, buildAttributeValidator(set));

const coffee = () =>
  attributeSet([
    attribute('roast', 'select', {
      options: options(['light', 'Light'], ['medium', 'Medium'], ['dark', 'Dark']),
      required: true,
      order: 0,
      group: 'Roast',
    }),
    attribute('weight_g', 'number', {
      options: options(['250', '250 g'], ['1000', '1 kg']),
      unit: 'g',
      order: 1,
    }),
    attribute('decaf', 'boolean', { order: 2 }),
    attribute('notes', 'multiselect', {
      options: options(['floral', 'Floral'], ['citrus', 'Citrus'], ['cocoa', 'Cocoa']),
      order: 3,
    }),
    attribute('altitude_m', 'number', { validation: { min: 0, max: 3000 }, unit: 'm', order: 4 }),
    attribute('story', 'text', { validation: { maxLength: 40 }, order: 5 }),
  ]);

describe('an admin cannot invent an attribute', () => {
  it('rejects a key the category does not bind', () => {
    // The whole point of defining attributes: if a stray form field could reach
    // storage, the catalogue would have no schema at all.
    expect(() => project({ roast: 'medium', smuggled: 'yes' }, coffee())).toThrowError(AppError);
  });

  it('rejects a value outside the defined options', () => {
    expect(() => project({ roast: 'burnt' }, coffee())).toThrowError(AppError);
  });

  it('rejects a value of the wrong type', () => {
    expect(() => project({ decaf: 'yes' }, coffee())).toThrowError(AppError);
    expect(() => project({ altitude_m: 'high' }, coffee())).toThrowError(AppError);
  });

  it('enforces the definition’s own range and length limits', () => {
    expect(() => project({ altitude_m: 9000 }, coffee())).toThrowError(AppError);
    expect(() => project({ story: 'x'.repeat(41) }, coffee())).toThrowError(AppError);
  });
});

describe('values land in typed slots', () => {
  it('routes each type to its own field, so an index can be built on it', () => {
    const { attributes } = project(
      {
        roast: 'medium',
        weight_g: 250,
        decaf: false,
        notes: ['floral', 'cocoa'],
        altitude_m: 1900,
        story: 'Washed at the mill.',
      },
      coffee(),
    );

    const by = Object.fromEntries(attributes.map((a) => [a.key, a]));
    expect(by.roast?.valueString).toBe('medium');
    expect(by.weight_g?.valueNumber).toBe(250);
    expect(by.decaf?.valueBool).toBe(false);
    expect(by.notes?.valueStrings).toEqual(['floral', 'cocoa']);
    expect(by.altitude_m?.valueNumber).toBe(1900);
    expect(by.story?.valueString).toBe('Washed at the mill.');

    // Nothing leaks into a slot that is not its own.
    expect(by.roast?.valueNumber).toBeUndefined();
    expect(by.weight_g?.valueString).toBeUndefined();
  });

  it('denormalises the rendered form so the product page needs no definition lookup', () => {
    const { attributes } = project(
      {
        roast: 'medium',
        weight_g: 1000,
        decaf: true,
        notes: ['floral', 'cocoa'],
        altitude_m: 1900,
      },
      coffee(),
    );
    const by = Object.fromEntries(attributes.map((a) => [a.key, a.displayValue]));

    expect(by.roast).toBe('Medium');
    expect(by.weight_g).toBe('1 kg'); // the option's label, not "1000 g"
    expect(by.decaf).toBe('Yes');
    expect(by.notes).toBe('Floral, Cocoa');
    expect(by.altitude_m).toBe('1900 m'); // no options, so value plus unit
  });

  it('keeps false and zero rather than treating them as absent', () => {
    const { attributes } = project({ decaf: false, altitude_m: 0 }, coffee());
    expect(attributes.map((a) => a.key).sort()).toEqual(['altitude_m', 'decaf']);
  });

  it('omits an attribute that was not supplied', () => {
    const { attributes } = project({ roast: 'dark' }, coffee());
    expect(attributes).toHaveLength(1);
  });
});

describe('lenient mode is what makes attributes editable in practice', () => {
  it('accepts a product missing a required attribute, and reports it', () => {
    // The scenario this exists for: an admin adds a required Roast Level to a category
    // that already holds forty products. None of them should break.
    const { attributes, issues } = project({ weight_g: 250 }, coffee());

    expect(attributes.map((a) => a.key)).toEqual(['weight_g']);
    expect(issues).toEqual([
      { key: 'roast', code: 'missing_required', message: 'Roast is required for this category.' },
    ]);
  });

  it('still refuses a value that is actually wrong', () => {
    // Lenient is about *absence*, never about accepting nonsense.
    expect(() => project({ roast: 'burnt' }, coffee())).toThrowError(AppError);
  });
});

describe('strict mode rejects instead of reporting', () => {
  it('fails the write when a required attribute is missing', () => {
    const set = { ...coffee(), validationMode: 'strict' as const };
    expect(() => project({ weight_g: 250 }, set)).toThrowError(AppError);
  });

  it('accepts the same product once the required attribute is present', () => {
    const set = { ...coffee(), validationMode: 'strict' as const };
    const { issues } = project({ roast: 'light', weight_g: 250 }, set);
    expect(issues).toEqual([]);
  });
});

describe('an unfinished definition cannot enter the catalogue', () => {
  it('refuses a select that has no options yet', () => {
    const set = attributeSet([attribute('glaze', 'select', { options: [] })]);
    expect(() => project({ glaze: 'anything' }, set)).toThrowError(AppError);
  });
});
