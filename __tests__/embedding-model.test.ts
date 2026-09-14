import { currentEmbeddingModel } from "@/lib/ai/embeddings";

// The check that was missing for four months. The category index stayed
// on AI Studio's gemini-embedding-001 while queries moved to Vertex's
// text-embedding-005 (2026-05-29). Both emit 768 dimensions, so pgvector
// never errored — it just compared unrelated vector spaces and returned
// confident nonsense. Nothing in the system could name the model behind a
// stored vector, so nothing could notice.
describe("currentEmbeddingModel", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("reports the Vertex model when Vertex is configured", () => {
    process.env.GCP_PROJECT_ID = "some-project";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "{}";
    expect(currentEmbeddingModel()).toBe("text-embedding-005");
  });

  it("reports an AI Studio model when Vertex is not configured", () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    expect(currentEmbeddingModel()).toBe("gemini-embedding-001");
  });

  it("needs BOTH Vertex env vars — a half-configured backend is AI Studio", () => {
    // Mirrors isVertexEmbeddingsEnabled exactly. If these ever disagreed,
    // rows would be stamped with a model that did not write them, which
    // is the precise failure this column exists to make impossible.
    process.env.GCP_PROJECT_ID = "some-project";
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    expect(currentEmbeddingModel()).toBe("gemini-embedding-001");

    delete process.env.GCP_PROJECT_ID;
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "{}";
    expect(currentEmbeddingModel()).toBe("gemini-embedding-001");
  });

  it("returns the two backends' models as DIFFERENT strings", () => {
    // The whole mechanism rests on this: if both backends reported the
    // same name, a switch would look like no change and the stale index
    // would never be rewritten.
    process.env.GCP_PROJECT_ID = "p";
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = "{}";
    const vertex = currentEmbeddingModel();
    delete process.env.GCP_PROJECT_ID;
    const aiStudio = currentEmbeddingModel();
    expect(vertex).not.toBe(aiStudio);
  });

  it("never returns empty — an empty model would stamp rows unidentifiably", () => {
    delete process.env.GCP_PROJECT_ID;
    expect(currentEmbeddingModel().length).toBeGreaterThan(0);
  });
});
