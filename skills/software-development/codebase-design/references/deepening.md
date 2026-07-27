# Deepening Modules

Use this reference after a real shallow cluster has been identified.

## Dependency categories

1. **In-process:** pure computation or memory. Merge behind the new interface and test it directly.
2. **Local-substitutable:** a realistic local stand-in exists. Keep the seam internal and test with the stand-in.
3. **Remote but owned:** define a port at the ownership boundary; use a production transport adapter and an in-memory test adapter.
4. **True external:** inject a narrow port; use a contract-aware fake or mock at that system boundary.

## Seam discipline

- One adapter usually means hypothetical indirection. Two justified adapters make a seam real.
- Internal test seams stay private; do not expose them merely for tests.
- The deep module owns policy. Adapters translate transport or external behavior.
- Keep external failure semantics explicit at the public interface.

## Test migration

Use the deep module's public interface as the test seam. Add behavior-equivalent tests first, prove them red-capable where possible, then remove obsolete shallow-module tests. Never delete tests merely because files were merged.
