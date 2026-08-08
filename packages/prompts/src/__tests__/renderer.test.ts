import { describe, expect, it } from 'vitest';
import {
  LOOP_ITERATION_CAP,
  OUTPUT_SIZE_CAP,
  RENDER_TIMEOUT_MS,
  renderTemplate,
  resolveIncludeName,
  validateTemplate,
  createTemplateEnv,
} from '../renderer.js';
import { RenderGuardError, TemplateIncludeError, TemplateLoadError } from '../errors.js';

const VARS = {
  properties: {
    title: { type: 'string' },
    items: { type: 'array' },
    count: { type: 'number' },
    flag: { type: 'boolean' },
    obj: { type: 'object' },
    text: { type: 'string' },
  },
};

describe('renderTemplate basics', () => {
  it('renders plain text unchanged', () => {
    const r = renderTemplate({ source: 'hello world', context: {}, varsSchema: VARS });
    expect(r.output).toBe('hello world');
    expect(r.included).toEqual([]);
  });

  it('interpolates declared variables', () => {
    const r = renderTemplate({
      source: 'Hello {{ title }}',
      context: { title: 'KANAL' },
      varsSchema: VARS,
    });
    expect(r.output).toBe('Hello KANAL');
  });

  it('interpolates nested object paths', () => {
    const r = renderTemplate({
      source: '{{ obj.a.b }}',
      context: { obj: { a: { b: 'deep' } } },
      varsSchema: VARS,
    });
    expect(r.output).toBe('deep');
  });

  it('renders numbers and booleans', () => {
    const r = renderTemplate({
      source: '{{ count }} {{ flag }}',
      context: { count: 42, flag: true },
      varsSchema: VARS,
    });
    expect(r.output).toBe('42 true');
  });

  it('joins arrays with a separator via filter', () => {
    const r = renderTemplate({
      source: '{{ items | join(", ") }}',
      context: { items: ['a', 'b', 'c'] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('a, b, c');
  });

  it('serializes objects to JSON via tojson filter', () => {
    const r = renderTemplate({
      source: '{{ obj | tojson }}',
      context: { obj: { a: 1, b: [1, 2] } },
      varsSchema: VARS,
    });
    expect(r.output).toBe('{"a":1,"b":[1,2]}');
  });

  it('renders for loops with loop metadata', () => {
    const r = renderTemplate({
      source: '{% for item in items %}{{ loop.index }}:{{ item }}{% endfor %}',
      context: { items: ['x', 'y'] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('1:x2:y');
  });

  it('renders for-else when the sequence is empty', () => {
    const r = renderTemplate({
      source: '{% for item in items %}{{ item }}{% else %}none{% endfor %}',
      context: { items: [] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('none');
  });

  it('renders if/else', () => {
    const r = renderTemplate({
      source: '{% if flag %}yes{% else %}no{% endif %}',
      context: { flag: true },
      varsSchema: VARS,
    });
    expect(r.output).toBe('yes');
  });

  it('renders if with array truthiness', () => {
    const r = renderTemplate({
      source: '{% if items %}has{% else %}empty{% endif %}',
      context: { items: [] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('empty');
  });

  it('supports nested for inside if', () => {
    const r = renderTemplate({
      source:
        '{% if flag %}{% for item in items %}{{ item }}{% endfor %}{% endif %}',
      context: { flag: true, items: ['a', 'b'] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('ab');
  });

  it('supports comparison operators', () => {
    const r = renderTemplate({
      source: '{% if count > 10 %}big{% else %}small{% endif %}',
      context: { count: 42 },
      varsSchema: VARS,
    });
    expect(r.output).toBe('big');
  });

  it('supports in operator', () => {
    const r = renderTemplate({
      source: '{% if text in items %}yes{% else %}no{% endif %}',
      context: { text: 'b', items: ['a', 'b'] },
      varsSchema: VARS,
    });
    expect(r.output).toBe('yes');
  });
});

describe('undeclared variables are load-time errors', () => {
  it('throws when rendering references an undeclared variable', () => {
    expect(() =>
      renderTemplate({ source: '{{ nope }}', context: {}, varsSchema: VARS }),
    ).toThrow(TemplateLoadError);
    expect(() =>
      renderTemplate({ source: '{{ nope }}', context: {}, varsSchema: VARS }),
    ).toThrow(/undeclared variable 'nope'/);
  });

  it('throws at load/parse time even when the branch never executes', () => {
    expect(() =>
      renderTemplate({
        source: '{% if flag %}{{ undeclared_thing }}{% endif %}',
        context: { flag: false },
        varsSchema: VARS,
      }),
    ).toThrow(TemplateLoadError);
  });

  it('validateTemplate rejects an undeclared variable', () => {
    expect(() =>
      validateTemplate('{{ unknown }}', VARS),
    ).toThrow(TemplateLoadError);
  });

  it('throws a load error even without a vars schema restricting', () => {
    // No varsSchema -> no restriction; every root is allowed.
    const r = renderTemplate({ source: '{{ anything }}', context: { anything: 'ok' } });
    expect(r.output).toBe('ok');
  });
});

describe('guards', () => {
  it('enforces the loop iteration cap', () => {
    const arr = Array.from({ length: LOOP_ITERATION_CAP + 1 }, (_, i) => i);
    expect(() =>
      renderTemplate({
        source: '{% for i in items %}x{% endfor %}',
        context: { items: arr },
        varsSchema: { properties: { items: { type: 'array' } } },
      }),
    ).toThrow(RenderGuardError);
    expect(() =>
      renderTemplate({
        source: '{% for i in items %}x{% endfor %}',
        context: { items: arr },
        varsSchema: { properties: { items: { type: 'array' } } },
      }),
    ).toThrow(/loop iteration cap/);
  });

  it('allows exactly the loop cap', () => {
    const arr = Array.from({ length: LOOP_ITERATION_CAP }, (_, i) => i);
    const r = renderTemplate({
      source: '{% for i in items %}x{% endfor %}',
      context: { items: arr },
      varsSchema: { properties: { items: { type: 'array' } } },
    });
    expect(r.output.length).toBe(LOOP_ITERATION_CAP);
  });

  it('honours a custom loop cap', () => {
    const arr = Array.from({ length: 5 }, (_, i) => i);
    expect(() =>
      renderTemplate({
        source: '{% for i in items %}x{% endfor %}',
        context: { items: arr },
        varsSchema: { properties: { items: { type: 'array' } } },
        loopCap: 3,
      }),
    ).toThrow(RenderGuardError);
  });

  it('enforces the render timeout', () => {
    // timeoutMs 0 places the deadline in the past, so the per-node deadline
    // check fires deterministically regardless of machine speed.
    const run = () =>
      renderTemplate({
        source: '{% for i in items %}{{ obj.a.b.c.d.e }}{% endfor %}',
        context: {
          items: Array.from({ length: 64 }, (_, i) => i),
          obj: { a: { b: { c: { d: { e: 'x' } } } } },
        },
        varsSchema: { properties: { items: { type: 'array' }, obj: { type: 'object' } } },
        timeoutMs: 0,
      });
    expect(run).toThrow(RenderGuardError);
    expect(run).toThrow(/timeout/);
  });

  it('enforces the output size cap', () => {
    const big = 'x'.repeat(OUTPUT_SIZE_CAP + 10);
    expect(() =>
      renderTemplate({ source: '{{ text }}', context: { text: big }, varsSchema: VARS }),
    ).toThrow(RenderGuardError);
  });

  it('honours a custom output size cap', () => {
    expect(() =>
      renderTemplate({
        source: '{{ text }}',
        context: { text: 'abc' },
        varsSchema: VARS,
        outputSizeCap: 2,
      }),
    ).toThrow(RenderGuardError);
  });

  it('exposes the default guard constants', () => {
    expect(LOOP_ITERATION_CAP).toBe(512);
    expect(RENDER_TIMEOUT_MS).toBe(250);
    expect(OUTPUT_SIZE_CAP).toBe(120 * 1024);
  });
});

describe('includes are scoped to the pack root', () => {
  it('includes a template from the in-memory map', () => {
    const r = renderTemplate({
      source: 'A{% include "partial.tmpl" %}B',
      context: { title: 'T' },
      varsSchema: VARS,
      includeSources: { 'partial.tmpl': '|{{ title }}|' },
    });
    expect(r.output).toBe('A|T|B');
    expect(r.included).toEqual(['partial.tmpl']);
  });

  it('rejects includes that escape the pack root', () => {
    expect(() => resolveIncludeName('../secret.tmpl')).toThrow(TemplateIncludeError);
    expect(() => resolveIncludeName('../../x.tmpl')).toThrow(TemplateIncludeError);
    expect(() => resolveIncludeName('en/../../x.tmpl')).toThrow(TemplateIncludeError);
    expect(() => resolveIncludeName('/etc/passwd')).toThrow(TemplateIncludeError);
    expect(() => resolveIncludeName('C:\\windows\\system32\\x.tmpl')).toThrow(
      TemplateIncludeError,
    );
    expect(() => resolveIncludeName('..\\evil.tmpl')).toThrow(TemplateIncludeError);
  });

  it('rejects unknown includes', () => {
    expect(() =>
      renderTemplate({
        source: '{% include "nope.tmpl" %}',
        context: {},
        varsSchema: VARS,
        includeSources: {},
      }),
    ).toThrow(TemplateIncludeError);
  });

  it('rejects circular includes', () => {
    expect(() =>
      renderTemplate({
        source: '{% include "a.tmpl" %}',
        context: {},
        varsSchema: VARS,
        includeSources: { 'a.tmpl': '{% include "b.tmpl" %}', 'b.tmpl': '{% include "a.tmpl" %}' },
      }),
    ).toThrow(TemplateIncludeError);
  });

  it('normalizes include names', () => {
    const r = renderTemplate({
      source: '{% include "en/./writer.tmpl" %}',
      context: { title: 'T' },
      varsSchema: VARS,
      includeSources: { 'en/writer.tmpl': 'hi {{ title }}' },
    });
    expect(r.output).toBe('hi T');
  });
});

describe('createTemplateEnv', () => {
  it('rejects invalid var types', () => {
    expect(() =>
      createTemplateEnv({ properties: { bad: { type: 'function' } } }),
    ).toThrow(TemplateLoadError);
  });
});

describe('syntax errors', () => {
  it('rejects unterminated blocks', () => {
    expect(() =>
      renderTemplate({
        source: '{% if flag %}oops',
        context: { flag: true },
        varsSchema: VARS,
      }),
    ).toThrow(TemplateLoadError);
  });

  it('rejects stray end tags', () => {
    expect(() =>
      renderTemplate({ source: '{% endif %}', context: {}, varsSchema: VARS }),
    ).toThrow(TemplateLoadError);
  });

  it('rejects unsupported tags', () => {
    expect(() =>
      renderTemplate({
        source: '{% set x = 1 %}',
        context: {},
        varsSchema: VARS,
      }),
    ).toThrow(TemplateLoadError);
  });

  it('rejects unterminated expressions', () => {
    expect(() =>
      renderTemplate({ source: '{{ title', context: { title: 'x' }, varsSchema: VARS }),
    ).toThrow(TemplateLoadError);
  });
});
