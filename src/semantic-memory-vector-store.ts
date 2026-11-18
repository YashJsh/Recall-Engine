import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingModel, FlagEmbedding } from "fastembed";
import type { SemanticMemoryCategory, SemanticMemoryStatus } from "./generated/prisma/enums.js";

const VECTOR_SIZE = 384;
const DEFAULT_COLLECTION = "semantic_memories";
const DEFAULT_URL = "http://127.0.0.1:6333";

export interface SemanticMemoryVectorScope {
  tenantId: string;
  userId: string;
}

export interface SemanticMemoryVectorInput extends SemanticMemoryVectorScope {
  id: string;
  content: string;
  category: SemanticMemoryCategory;
  status: SemanticMemoryStatus;
}

export interface SimilarSemanticMemoryId {
  semanticMemoryId: string;
  score: number;
}

interface TextEmbedder {
  embedPassage(text: string): Promise<number[]>;
  embedQuery(text: string): Promise<number[]>;
}

interface QdrantAdapter {
  collectionExists(collectionName: string): Promise<{ exists: boolean }>;
  createCollection(collectionName: string, config: {
    vectors: { size: number; distance: "Cosine" };
  }): Promise<boolean>;
  createPayloadIndex(collectionName: string, config: {
    field_name: string;
    field_schema: "keyword";
  }): Promise<unknown>;
  upsert(collectionName: string, input: {
    wait: boolean;
    points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, string>;
    }>;
  }): Promise<unknown>;
  setPayload(collectionName: string, input: {
    wait: boolean;
    points: string[];
    payload: Record<string, string>;
  }): Promise<unknown>;
  query(collectionName: string, input: {
    query: number[];
    limit: number;
    with_payload: false;
    filter: {
      must: Array<{ key: string; match: { value: string } }>;
    };
  }): Promise<{ points: Array<{ id: string | number; score: number }> }>;
}

interface SemanticMemoryVectorStoreOptions {
  url?: string;
  collectionName?: string;
  client?: QdrantAdapter;
  embedder?: TextEmbedder;
}

/** Stores fact vectors in Qdrant; PostgreSQL remains authoritative for fact content and provenance. */
export class SemanticMemoryVectorStore {
  private readonly client: QdrantAdapter;
  private readonly collectionName: string;
  private readonly embedder: TextEmbedder;
  private collectionReady?: Promise<void>;

  constructor(options: SemanticMemoryVectorStoreOptions = {}) {
    this.client = options.client ?? new QdrantClient({
      url: options.url ?? process.env.QDRANT_URL ?? DEFAULT_URL,
    }) as unknown as QdrantAdapter;
    this.collectionName = options.collectionName ?? process.env.QDRANT_COLLECTION ?? DEFAULT_COLLECTION;
    this.embedder = options.embedder ?? new FastEmbedTextEmbedder();
  }

  async index(memory: SemanticMemoryVectorInput): Promise<void> {
    await this.ensureCollection();
    const vector = await this.embedder.embedPassage(memory.content);
    this.validateVector(vector);
    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [{
        id: memory.id,
        vector,
        payload: {
          tenantId: memory.tenantId,
          userId: memory.userId,
          category: memory.category,
          status: memory.status,
        },
      }],
    });
  }

  async updateStatus(memoryId: string, status: SemanticMemoryStatus): Promise<void> {
    await this.ensureCollection();
    await this.client.setPayload(this.collectionName, {
      wait: true,
      points: [memoryId],
      payload: { status },
    });
  }

  async findSimilar(
    scope: SemanticMemoryVectorScope,
    queryText: string,
    options: { limit?: number; scoreThreshold?: number } = {},
  ): Promise<SimilarSemanticMemoryId[]> {
    if (!queryText.trim()) throw new Error("queryText must not be empty");
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }

    await this.ensureCollection();
    const vector = await this.embedder.embedQuery(queryText);
    this.validateVector(vector);
    const result = await this.client.query(this.collectionName, {
      query: vector,
      limit,
      with_payload: false,
      filter: {
        must: [
          { key: "tenantId", match: { value: scope.tenantId } },
          { key: "userId", match: { value: scope.userId } },
          { key: "status", match: { value: "active" } },
        ],
      },
    });

    return result.points
      .filter((point) => options.scoreThreshold === undefined || point.score >= options.scoreThreshold)
      .map((point) => ({ semanticMemoryId: String(point.id), score: point.score }));
  }

  private ensureCollection(): Promise<void> {
    if (!this.collectionReady) {
      this.collectionReady = this.createCollectionIfMissing().catch((error: unknown) => {
        this.collectionReady = undefined;
        throw error;
      });
    }
    return this.collectionReady;
  }

  private async createCollectionIfMissing(): Promise<void> {
    const existing = await this.client.collectionExists(this.collectionName);
    if (existing.exists) return;

    await this.client.createCollection(this.collectionName, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    for (const field_name of ["tenantId", "userId", "status"]) {
      await this.client.createPayloadIndex(this.collectionName, {
        field_name,
        field_schema: "keyword",
      });
    }
  }

  private validateVector(vector: number[]): void {
    if (vector.length !== VECTOR_SIZE || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding must contain ${VECTOR_SIZE} finite numbers`);
    }
  }
}

class FastEmbedTextEmbedder implements TextEmbedder {
  private modelPromise?: Promise<FlagEmbedding>;

  async embedPassage(text: string): Promise<number[]> {
    const model = await this.getModel();
    const batches = model.passageEmbed([text], 1);
    const first = await batches.next();
    const vector = first.value?.[0];
    if (!vector) throw new Error("FastEmbed did not return a passage embedding");
    return vector;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.getModel().then((model) => model.queryEmbed(text));
  }

  private getModel(): Promise<FlagEmbedding> {
    this.modelPromise ??= FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      showDownloadProgress: true,
    });
    return this.modelPromise;
  }
}
