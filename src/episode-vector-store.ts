import { QdrantClient } from "@qdrant/js-client-rest";
import type { EpisodeType } from "./generated/prisma/enums.js";
import {
  FastEmbedTextEmbedder,
  type QdrantAdapter,
  type TextEmbedder,
} from "./semantic-memory-vector-store.js";

const VECTOR_SIZE = 384;
const DEFAULT_COLLECTION = "episodes";
const DEFAULT_URL = "http://127.0.0.1:6333";

export interface EpisodeVectorScope {
  tenantId: string;
  userId: string;
}

export interface EpisodeVectorInput extends EpisodeVectorScope {
  id: string;
  content: string;
  type: EpisodeType;
}

export interface SimilarEpisodeId {
  episodeId: string;
  score: number;
}

export interface EpisodeVectorStoreOptions {
  url?: string;
  collectionName?: string;
  client?: QdrantAdapter;
  /** Share the semantic store's embedder so the model loads once. */
  embedder?: TextEmbedder;
}

/** Stores episode vectors in their own Qdrant collection; PostgreSQL stays authoritative. */
export class EpisodeVectorStore {
  private readonly client: QdrantAdapter;
  private readonly collectionName: string;
  private readonly embedder: TextEmbedder;
  private collectionReady?: Promise<void>;

  constructor(options: EpisodeVectorStoreOptions = {}) {
    this.client = options.client ?? new QdrantClient({
      url: options.url ?? process.env.QDRANT_URL ?? DEFAULT_URL,
    }) as unknown as QdrantAdapter;
    this.collectionName = options.collectionName ?? process.env.QDRANT_EPISODE_COLLECTION ?? DEFAULT_COLLECTION;
    this.embedder = options.embedder ?? new FastEmbedTextEmbedder();
  }

  async index(episode: EpisodeVectorInput): Promise<void> {
    await this.ensureCollection();
    const vector = await this.embedder.embedPassage(episode.content);
    this.validateVector(vector);
    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [{
        id: episode.id,
        vector,
        payload: { tenantId: episode.tenantId, userId: episode.userId, type: episode.type },
      }],
    });
  }

  async findSimilar(
    scope: EpisodeVectorScope,
    queryText: string,
    options: { limit?: number; scoreThreshold?: number } = {},
  ): Promise<SimilarEpisodeId[]> {
    if (!queryText.trim()) throw new Error("queryText must not be empty");
    const limit = options.limit ?? 3;
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
        ],
      },
    });

    return result.points
      .filter((point) => options.scoreThreshold === undefined || point.score >= options.scoreThreshold)
      .map((point) => ({ episodeId: String(point.id), score: point.score }));
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
    for (const field_name of ["tenantId", "userId", "type"]) {
      await this.client.createPayloadIndex(this.collectionName, { field_name, field_schema: "keyword" });
    }
  }

  private validateVector(vector: number[]): void {
    if (vector.length !== VECTOR_SIZE || vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`Embedding must contain ${VECTOR_SIZE} finite numbers`);
    }
  }
}
