# Test Design and Mocking

Load this reference when selecting a test seam, checking whether an expected
value is independent, or deciding whether a mock is justified.

## Test through behavior

A durable test calls the same public interface a real caller uses and asserts an
observable result. It survives internal refactors because it does not inspect
private methods, internal call order, or hidden storage.

Prefer:

- a known literal from a worked example;
- an accepted requirement or protocol example;
- an independently calculated fixture;
- retrieval through the public interface that performed the write.

Avoid recomputing the expected result with the production algorithm. That is a
tautological oracle: implementation and test can share the same mistake.

## Pick the narrowest sufficient seam

- **Unit seam:** deterministic domain rule with no meaningful integration risk.
- **Integration seam:** behavior depends on collaborating project modules,
  serialization, persistence, configuration, or framework wiring.
- **End-to-end seam:** the requirement is user-visible and lower seams cannot
  prove the real path.

Choose based on the failure the test must detect, not on which test is easiest
to write.

## Mock at system boundaries

Good mock targets are things the project does not control or cannot make
deterministic in a focused test: remote APIs, clocks, randomness, external
processes, and sometimes filesystems or databases. Prefer a real test database
or temporary filesystem when practical.

Do not mock project-owned internal collaborators merely to make a unit test
possible. If every collaborator needs a mock, reconsider the public interface
or move the test to a wider seam.

Mock behavior should be specific and static. Conditional mini-implementations
inside mocks often recreate the production logic and make the test tautological.
