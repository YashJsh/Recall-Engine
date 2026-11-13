import type { RedisClientType } from "redis";

export interface WorkingMemoryScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface WorkingMemoryItem {
  id: string;
  content: string;
  tokenCount: number;
  /** Larger values are kept in memory longer. */
  priority: number;
  protected?: boolean;
}

export interface WorkingMemoryOptions {
  tokenBudget: number;
  sessionTtlMs: number;
  keyPrefix?: string;
  now?: () => number;
}

export interface AddItemResult {
  accepted: boolean;
  evicted: string[];
  tokenUsage: number;
}

interface StoredWorkingMemoryItem extends WorkingMemoryItem {
  protected: boolean;
  addedAt: number;
}

const ADD_ITEM_SCRIPT = `
local key = KEYS[1]
local incoming = cjson.decode(ARGV[1])
local budget = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local existing = redis.call('HGETALL', key)
local proposed = {}
local usage = 0
local originalUsage = 0

for index = 1, #existing, 2 do
  local item = cjson.decode(existing[index + 1])
  originalUsage = originalUsage + tonumber(item.tokenCount)
  if item.id ~= incoming.id then
    table.insert(proposed, item)
    usage = usage + tonumber(item.tokenCount)
  end
end

table.insert(proposed, incoming)
usage = usage + tonumber(incoming.tokenCount)
local evicted = {}

while usage > budget do
  local victimIndex = nil
  for index, item in ipairs(proposed) do
    if not item.protected then
      if victimIndex == nil then
        victimIndex = index
      else
        local current = proposed[victimIndex]
        if tonumber(item.priority) < tonumber(current.priority)
          or (tonumber(item.priority) == tonumber(current.priority)
            and (tonumber(item.addedAt) < tonumber(current.addedAt)
              or (tonumber(item.addedAt) == tonumber(current.addedAt)
                and item.id < current.id))) then
          victimIndex = index
        end
      end
    end
  end

  if victimIndex == nil then
    return {0, '[]', originalUsage}
  end

  local victim = table.remove(proposed, victimIndex)
  usage = usage - tonumber(victim.tokenCount)
  table.insert(evicted, victim.id)
  if victim.id == incoming.id then
    return {0, '[]', originalUsage}
  end
end

for _, id in ipairs(evicted) do
  redis.call('HDEL', key, id)
end
redis.call('HSET', key, incoming.id, cjson.encode(incoming))
redis.call('PEXPIRE', key, ttl)
return {1, cjson.encode(evicted), usage}
`;

const READ_ITEMS_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
if redis.call('EXISTS', key) == 1 then
  redis.call('PEXPIRE', key, ttl)
end
return redis.call('HVALS', key)
`;

/** Redis-backed, session-scoped working memory with atomic budget enforcement. */
export class RedisWorkingMemory {
  private readonly now: () => number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisClientType,
    private readonly options: WorkingMemoryOptions,
  ) {
    if (!Number.isInteger(options.tokenBudget) || options.tokenBudget < 1) {
      throw new Error("tokenBudget must be a positive integer");
    }
    if (!Number.isFinite(options.sessionTtlMs) || options.sessionTtlMs <= 0) {
      throw new Error("sessionTtlMs must be a positive number");
    }
    this.now = options.now ?? Date.now;
    this.keyPrefix = options.keyPrefix ?? "recall:working";
  }

  async addItem(scope: WorkingMemoryScope, item: WorkingMemoryItem): Promise<AddItemResult> {
    this.validate(scope, item);
    const storedItem: StoredWorkingMemoryItem = {
      ...item,
      protected: item.protected ?? false,
      addedAt: this.now(),
    };
    const raw = await this.redis.eval(ADD_ITEM_SCRIPT, {
      keys: [this.sessionKey(scope)],
      arguments: [
        JSON.stringify(storedItem),
        String(this.options.tokenBudget),
        String(this.options.sessionTtlMs),
      ],
    });
    const [accepted, evictedJson, tokenUsage] = raw as [number, string, number];
    return {
      accepted: Number(accepted) === 1,
      evicted: JSON.parse(evictedJson) as string[],
      tokenUsage: Number(tokenUsage),
    };
  }

  async getItems(scope: WorkingMemoryScope): Promise<WorkingMemoryItem[]> {
    this.validateScope(scope);
    const rawItems = await this.redis.eval(READ_ITEMS_SCRIPT, {
      keys: [this.sessionKey(scope)],
      arguments: [String(this.options.sessionTtlMs)],
    });
    return (rawItems as string[])
      .map((value) => JSON.parse(value) as StoredWorkingMemoryItem)
      .sort((left, right) => left.addedAt - right.addedAt)
      .map(({ addedAt: _addedAt, ...item }) => item);
  }

  async getTokenUsage(scope: WorkingMemoryScope): Promise<number> {
    const items = await this.getItems(scope);
    return items.reduce((total, item) => total + item.tokenCount, 0);
  }

  async clearSession(scope: WorkingMemoryScope): Promise<void> {
    this.validateScope(scope);
    await this.redis.del(this.sessionKey(scope));
  }

  private sessionKey(scope: WorkingMemoryScope): string {
    const parts = [scope.tenantId, scope.userId, scope.sessionId]
      .map((part) => encodeURIComponent(part));
    // One Redis Cluster hash tag keeps each session's atomic script on one slot.
    return `${this.keyPrefix}:{${parts.join("|")}}:items`;
  }

  private validate(scope: WorkingMemoryScope, item: WorkingMemoryItem): void {
    this.validateScope(scope);
    if (!item.id.trim()) throw new Error("item.id must not be empty");
    if (!Number.isInteger(item.tokenCount) || item.tokenCount < 0) {
      throw new Error("item.tokenCount must be a non-negative integer");
    }
    if (item.tokenCount > this.options.tokenBudget) {
      throw new Error("item.tokenCount cannot exceed the session token budget");
    }
    if (!Number.isFinite(item.priority)) throw new Error("item.priority must be finite");
  }

  private validateScope(scope: WorkingMemoryScope): void {
    for (const [name, value] of Object.entries(scope)) {
      if (!value.trim()) throw new Error(`${name} must not be empty`);
    }
  }
}
