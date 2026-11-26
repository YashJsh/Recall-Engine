import type {
  CreateEventEpisodeInput,
  EpisodeRecord,
  EpisodeScope,
  EpisodeStore,
} from "./episode-store.js";
import type { EpisodeVectorInput } from "./episode-vector-store.js";
import type { EventEpisodeWriter } from "./semantic-memory-extraction-service.js";

export interface EpisodeIndexer {
  index(episode: EpisodeVectorInput): Promise<void>;
}

/** Saves episodes to PostgreSQL and indexes them for retrieval. */
export class IndexedEpisodeWriter implements EventEpisodeWriter {
  constructor(
    private readonly store: EpisodeStore,
    private readonly indexer: EpisodeIndexer,
  ) {}

  async saveEvent(scope: EpisodeScope, input: CreateEventEpisodeInput): Promise<EpisodeRecord | null> {
    const episode = await this.store.createEvent(scope, input);
    if (episode) await this.indexEpisode(episode);
    return episode;
  }

  async indexEpisode(episode: EpisodeRecord): Promise<void> {
    await this.indexer.index({
      id: episode.id,
      tenantId: episode.tenantId,
      userId: episode.userId,
      content: episode.content,
      type: episode.type,
    });
  }
}
