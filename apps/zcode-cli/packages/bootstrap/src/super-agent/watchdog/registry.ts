import {
  BackgroundRunOwnershipError,
  type BackgroundRunListFilter,
  type BackgroundRunOwner,
  type BackgroundRunRegistration,
  type BackgroundRunRow,
  type BackgroundRunTerminalState,
  type BackgroundRunTouchPatch,
} from "./contract.js";

const TERMINAL_STATES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "lost",
  "dropped",
]);

/**
 * registry 行的持久投影端口。registry 仍是唯一写者：本端口只落行快照，不参与所有权判定。
 * 写失败原样上抛（fail-closed），不静默丢行。
 */
export interface BackgroundRunPersistence {
  loadAll(): readonly BackgroundRunRow[];
  write(row: BackgroundRunRow): void;
  delete(id: string): void;
}

/**
 * BackgroundRun registry：行级所有权投影（M8）。
 *
 * 不变量（spec §1）：
 * - 每行 owner 在 register 时定死；行存在时仅 owner 可 settle/touch，异 owner 一律抛
 *   BackgroundRunOwnershipError（第二写者响亮拒绝，不排队不合并）。
 * - settle/touch 行缺席 = no-op（该 run 未经过本投影）：投影不在业务路径上，不得因
 *   钩子接缝缺口阻断 deleteRun/cancelTask。
 * - 终态行 FIFO 保留 terminalRowRetention 条，供对账与审计；running 行不淘汰。
 * - 所有读返回拷贝：调用方拿到的是快照，对 registry 再写不影响已返回数组。
 * - 注入 persistence 时每次变更同步落库；daemon 重启用 {@link hydrate} 从同一表恢复。
 */
export class BackgroundRunRegistry {
  private readonly rows = new Map<string, BackgroundRunRow>();
  /** 终态行插入序（FIFO 淘汰用）。 */
  private readonly terminalOrder: string[] = [];

  constructor(
    private readonly terminalRowRetention: number,
    private readonly persistence?: BackgroundRunPersistence,
  ) {}

  /** 从持久行恢复；只允许空 registry 调用（进程启动时一次）。 */
  hydrate(rows: readonly BackgroundRunRow[]): void {
    if (this.rows.size > 0) {
      throw new Error("BackgroundRunRegistry.hydrate requires an empty registry");
    }
    const terminal = rows.filter(isTerminalRow).sort(
      (a, b) => (a.terminalAt ?? a.updatedAt) - (b.terminalAt ?? b.updatedAt),
    );
    for (const row of rows) {
      this.rows.set(row.id, { ...row });
    }
    for (const row of terminal) {
      this.terminalOrder.push(row.id);
    }
    this.evictTerminalOverflow();
  }

  register(registration: BackgroundRunRegistration, now: number): void {
    const existing = this.rows.get(registration.id);
    if (existing && existing.owner !== registration.owner) {
      throw new BackgroundRunOwnershipError(registration.id, registration.owner, existing.owner);
    }
    if (existing && !isTerminalRow(existing)) {
      // 同 owner 重复 register = upsert：身份面保留，时钟面刷新。
      const row: BackgroundRunRow = {
        ...existing,
        ownerSession: registration.ownerSession ?? existing.ownerSession,
        workspaceKey: registration.workspaceKey ?? existing.workspaceKey,
        narrowResultRef: registration.narrowResultRef ?? existing.narrowResultRef,
        stallClockRef: registration.stallClockRef ?? existing.stallClockRef,
        stalledSince: registration.stalledSince ?? existing.stalledSince,
        // 心跳声明随重臂刷新：显式传 false 可撤回承诺，缺席则沿用既有声明。
        heartbeat: registration.heartbeat ?? existing.heartbeat,
        updatedAt: now,
      };
      this.rows.set(registration.id, row);
      this.persist(row);
      return;
    }
    // 首登，或终态行上的重臂（新生命周期）：复位结算面。
    if (existing) this.removeFromTerminalOrder(registration.id);
    const row: BackgroundRunRow = {
      id: registration.id,
      kind: registration.kind,
      owner: registration.owner,
      ownerSession: registration.ownerSession,
      workspaceKey: registration.workspaceKey,
      state: "running",
      narrowResultRef: registration.narrowResultRef,
      stallClockRef: registration.stallClockRef,
      stalledSince: registration.stalledSince,
      heartbeat: registration.heartbeat,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
    };
    this.rows.set(registration.id, row);
    this.persist(row);
  }

  settle(
    id: string,
    owner: BackgroundRunOwner,
    state: BackgroundRunTerminalState,
    now: number,
    opts?: { narrowResultRef?: string; terminalReason?: string },
  ): void {
    // 行缺席 = 该 run 未经过本投影（钩子接缝缺口 / 终态行已按保留上限淘汰）：no-op，
    // 不抛——投影不得阻断 deleteRun/cancelTask 等业务路径。所有权违例只在**行存在**时
    // 响亮拒绝（异 owner 写 = 第二写者）。
    const row = this.rows.get(id);
    if (!row) return;
    if (row.owner !== owner) throw new BackgroundRunOwnershipError(id, owner, row.owner);
    if (isTerminalRow(row)) {
      // 终态只由 owner 原子回写一次；重复同态幂等，异态不覆盖（先到先得）。
      if (
        row.state === state &&
        opts?.narrowResultRef !== undefined &&
        row.narrowResultRef === undefined
      ) {
        const next = { ...row, narrowResultRef: opts.narrowResultRef };
        this.rows.set(id, next);
        this.persist(next);
      }
      return;
    }
    const next: BackgroundRunRow = {
      ...row,
      state,
      narrowResultRef: opts?.narrowResultRef ?? row.narrowResultRef,
      updatedAt: now,
      terminalAt: now,
      ...(opts?.terminalReason === undefined ? {} : { terminalReason: opts.terminalReason }),
    };
    this.rows.set(id, next);
    this.persist(next);
    this.pushTerminalOrder(id);
    this.evictTerminalOverflow();
  }

  touch(id: string, owner: BackgroundRunOwner, patch: BackgroundRunTouchPatch, now: number): void {
    const row = this.rows.get(id);
    if (!row) return; // 同 settle：行缺席 no-op，不阻断业务路径
    if (row.owner !== owner) throw new BackgroundRunOwnershipError(id, owner, row.owner);
    if (isTerminalRow(row)) return; // 终态行不再被局部更新（对账只读）
    const next: BackgroundRunRow = {
      ...row,
      ownerSession: patch.ownerSession ?? row.ownerSession,
      workspaceKey: patch.workspaceKey ?? row.workspaceKey,
      narrowResultRef: patch.narrowResultRef ?? row.narrowResultRef,
      stallClockRef: patch.stallClockRef ?? row.stallClockRef,
      stalledSince: patch.stalledSince ?? row.stalledSince,
      updatedAt: now,
    };
    this.rows.set(id, next);
    this.persist(next);
  }

  /**
   * 从持久表增量合并外部 owner 写入的行（跨进程 projection）：只覆盖更新更晚的行，
   * 不删除本地行（本地 owner 的终态仍由本进程写）。用于 automation 行由 services
   * 进程落库、app 进程 watchdog 需要实时看见的场景。
   */
  refreshFromPersistence(accept?: (row: BackgroundRunRow) => boolean): void {
    if (this.persistence === undefined) return;
    for (const row of this.persistence.loadAll()) {
      if (accept !== undefined && !accept(row)) continue;
      const current = this.rows.get(row.id);
      if (current !== undefined && current.updatedAt >= row.updatedAt) continue;
      this.rows.set(row.id, { ...row });
      if (isTerminalRow(row) && !this.terminalOrder.includes(row.id)) {
        this.terminalOrder.push(row.id);
      }
    }
    this.evictTerminalOverflow();
  }

  list(filter?: BackgroundRunListFilter): readonly BackgroundRunRow[] {
    const all = [...this.rows.values()].map((row) => ({ ...row }));
    if (!filter) return all;
    return all.filter(
      (row) =>
        (filter.owner === undefined || row.owner === filter.owner) &&
        (filter.kind === undefined || row.kind === filter.kind) &&
        (filter.state === undefined || row.state === filter.state),
    );
  }

  get(id: string): BackgroundRunRow | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  private persist(row: BackgroundRunRow): void {
    this.persistence?.write({ ...row });
  }

  private pushTerminalOrder(id: string): void {
    if (!this.terminalOrder.includes(id)) this.terminalOrder.push(id);
  }

  private removeFromTerminalOrder(id: string): void {
    const index = this.terminalOrder.indexOf(id);
    if (index >= 0) this.terminalOrder.splice(index, 1);
  }

  private evictTerminalOverflow(): void {
    while (this.terminalOrder.length > this.terminalRowRetention) {
      const oldest = this.terminalOrder.shift();
      if (oldest === undefined) return;
      this.rows.delete(oldest);
      this.persistence?.delete(oldest);
    }
  }
}

function isTerminalRow(row: BackgroundRunRow): boolean {
  return row.state !== "running" && TERMINAL_STATES.has(row.state);
}
