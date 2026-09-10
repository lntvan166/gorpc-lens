import * as assert from 'assert';
import { matchGlob } from '../../src/core/glob';

describe('matchGlob', () => {
  it('matches the default exclude against a nested generated file', () => {
    assert.strictEqual(matchGlob('/repo/protos/x/y_grpc.pb.go', '**/*.pb.go'), true);
  });

  it('matches a generated file at the root', () => {
    assert.strictEqual(matchGlob('y.pb.go', '**/*.pb.go'), true);
  });

  it('does not match hand-written go', () => {
    assert.strictEqual(matchGlob('/repo/svc/handler.go', '**/*.pb.go'), false);
  });

  it('keeps a single star inside one path segment', () => {
    assert.strictEqual(matchGlob('/repo/a/b.go', '/repo/*/b.go'), true);
    assert.strictEqual(matchGlob('/repo/a/c/b.go', '/repo/*/b.go'), false);
  });

  it('treats dots literally rather than as regex wildcards', () => {
    assert.strictEqual(matchGlob('/repo/axpb!go', '**/*.pb.go'), false);
  });

  it('supports ? as a single non-separator character', () => {
    assert.strictEqual(matchGlob('/repo/a1.go', '/repo/a?.go'), true);
    assert.strictEqual(matchGlob('/repo/a/.go', '/repo/a?.go'), false);
  });

  it('supports a trailing ** as match-anything', () => {
    assert.strictEqual(matchGlob('/repo/vendor/x/y.go', '/repo/vendor/**'), true);
  });
});
