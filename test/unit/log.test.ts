import * as assert from 'assert';
import { formatTrace } from '../../src/core/trace';

describe('formatTrace', () => {
  it('formats a stage and detail without timing', () => {
    assert.strictEqual(formatTrace('definition', '1 result'), '[definition] 1 result');
  });

  it('appends rounded milliseconds when timing is given', () => {
    assert.strictEqual(formatTrace('handlers', '2 results', 12.4), '[handlers] 2 results (12ms)');
  });

  it('treats a zero duration as a real timing, not as absent', () => {
    assert.strictEqual(formatTrace('cache', 'hit', 0), '[cache] hit (0ms)');
  });
});
