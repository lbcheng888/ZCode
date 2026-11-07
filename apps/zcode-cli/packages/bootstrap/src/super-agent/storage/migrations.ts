import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";

/**
 * daemon 域库首迁：一次性建全 Phase 2 表（spec super-agent-trigger-subsystem-spec
 * §1.2–§1.5、§1.7–§1.8），纯增量、不影响既有库路径。dispatch_requests 落
 * tasks-index 库（§1.6），不在本迁移。历史迁移 SQL 发布后不可修改；结构变更只能追加新迁移。
 */
export const SUPER_AGENT_MIGRATIONS: readonly SqliteMigration[] = [
  {
    appVersion: "0.17.0",
    id: "0001_super_agent_base",
    touchedTables: [
      "trigger_events",
      "trigger_subscriptions",
      "mandate",
      "write_leases",
      "decision_log",
      "control_plane_leases",
    ],
    sql: `
      create table if not exists trigger_events (
        id text primary key,
        workspace_identity text not null,
        source text not null,
        thread_key text not null,
        actor_kind text not null,
        actor_id text,
        payload text not null,
        payload_digest text not null,
        taint integer not null default 1,
        provider text,
        provider_message_id text,
        fast_path text,
        adjudication_status text,
        final_disposition text,
        settled_at integer,
        created_at integer not null,
        updated_at integer not null
      );

      -- 三层幂等的持久层（M2 Fast Path）；进程内 markInboundDelivery Map 降级为快速守卫。
      create unique index if not exists trigger_events_provider_message_uidx
        on trigger_events(provider, provider_message_id)
        where provider_message_id is not null;

      create index if not exists trigger_events_workspace_created_idx
        on trigger_events(workspace_identity, created_at);
      create index if not exists trigger_events_workspace_thread_created_idx
        on trigger_events(workspace_identity, thread_key, created_at);

      create table if not exists trigger_subscriptions (
        id text primary key,
        workspace_identity text not null,
        thread_key text not null,
        session_id text not null,
        lane text not null,
        filters text,
        owner_kind text not null,
        owner_ref text,
        status text not null,
        lease_expires_at integer not null,
        created_at integer not null,
        updated_at integer not null
      );

      -- 回填与写入幂等（INSERT OR IGNORE）：同订阅者仅允许一条 active 行。
      create unique index if not exists trigger_subscriptions_active_uidx
        on trigger_subscriptions(workspace_identity, thread_key, session_id)
        where status = 'active';

      create index if not exists trigger_subscriptions_active_lookup_idx
        on trigger_subscriptions(workspace_identity, thread_key)
        where status = 'active';
      create index if not exists trigger_subscriptions_lease_idx
        on trigger_subscriptions(lease_expires_at)
        where status = 'active';

      create table if not exists mandate (
        id text primary key,
        workspace_identity text not null,
        trigger_class text not null,
        tier text not null,
        scope text,
        policy_version integer not null,
        resume_after_restart integer not null default 0,
        expires_at integer,
        status text not null,
        created_at integer not null,
        updated_at integer not null
      );

      create unique index if not exists mandate_active_uidx
        on mandate(workspace_identity, trigger_class)
        where status = 'active';

      create table if not exists write_leases (
        id text primary key,
        workspace_identity text not null,
        owner_run_id text not null,
        scope text not null,
        status text not null,
        lease_expires_at integer not null,
        created_at integer not null,
        updated_at integer not null
      );

      create table if not exists decision_log (
        id text primary key,
        workspace_identity text not null,
        trigger_id text,
        origin text not null,
        disposition text not null,
        batch_id text,
        model_tier text,
        reason text,
        evidence text,
        created_at integer not null
      );

      create index if not exists decision_log_workspace_created_idx
        on decision_log(workspace_identity, created_at);
      create index if not exists decision_log_trigger_idx on decision_log(trigger_id);
      create index if not exists decision_log_batch_idx on decision_log(batch_id);

      create table if not exists control_plane_leases (
        workspace_identity text primary key,
        owner_id text not null,
        role text not null,
        expires_at integer not null,
        heartbeat_at integer not null
      );
    `,
  },
  {
    // M6 五字段方案卡（2026-11-02 用户裁定）：would-accept 卡的结构化内容列。
    // additive：旧行 card_payload 为 NULL，收件箱出口按门禁决定是否呈现。
    //
    // 回滚闭环修复（2026-11-05 迁移审查 major）：restore 会按 backup.json 删除本迁移的账本行，
    // 但 card_payload 列留在 schema 里；重开时非幂等 ALTER 会报 duplicate column name，库直接打不开。
    // apply 先查 PRAGMA table_info 再 ALTER，幂等可重跑；sql 字符串保持逐字节不变——
    // runner 的 checksum 只对 migration.sql 取 sha256，已落账库不会 mismatch。
    appVersion: "0.17.1",
    id: "0002_decision_log_card_payload",
    touchedTables: ["decision_log"],
    sql: `alter table decision_log add column card_payload text;`,
    apply: (db) => {
      const hasColumn = db
        .prepare("PRAGMA table_info(decision_log)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "card_payload");
      if (!hasColumn) db.exec("alter table decision_log add column card_payload text;");
    },
  },
  {
    // S0：background_run_registry 的持久投影（spec §7-1）。纯增量表；registry 仍是唯一
    // 写者，本表只落行快照供 daemon 重启 hydrate 与 runs.list 对账。kind/owner 是开放
    // 字符串列（新增子系统不改 schema），行级所有权由 registry 代码复核。
    appVersion: "0.17.2",
    id: "0003_background_run_registry",
    touchedTables: ["background_run_registry"],
    sql: `
      create table if not exists background_run_registry (
        id text primary key,
        kind text not null,
        owner text not null,
        owner_session text,
        workspace_key text,
        state text not null,
        narrow_result_ref text,
        stall_clock_ref text,
        stalled_since integer,
        heartbeat integer,
        registered_at integer not null,
        updated_at integer not null,
        terminal_at integer,
        terminal_reason text
      );

      create index if not exists background_run_registry_state_idx
        on background_run_registry(state, kind);
      create index if not exists background_run_registry_owner_idx
        on background_run_registry(owner, state);
    `,
  },
  {
    // S1：write lease 第二写者硬拒绝（spec §6.4）。P2 只建表未启用，历史库可能没有
    // active 行；若手工/测试留下多条，先保留每 workspace 最新一条、其余置 released，
    // 再建 partial unique index。索引是跨进程竞态的最终裁决，仓储层仍先查后写给出 typed 冲突。
    appVersion: "0.17.3",
    id: "0004_write_lease_single_active",
    touchedTables: ["write_leases"],
    sql: `
      update write_leases set status = 'released'
      where status = 'active'
        and exists (
          select 1 from write_leases newer
          where newer.workspace_identity = write_leases.workspace_identity
            and newer.status = 'active'
            and (
              newer.created_at > write_leases.created_at
              or (newer.created_at = write_leases.created_at and newer.id > write_leases.id)
            )
        );

      create unique index if not exists write_leases_single_active_uidx
        on write_leases(workspace_identity)
        where status = 'active';
    `,
  },
  {
    // S2：verdict 可选的 ChengPlan 引用落 decision_log。additive 可空列；restore 会删账本
    // 行但保留列，apply 先查 PRAGMA 再 ALTER，幂等可重跑（与 0002 同款回滚闭环）。
    appVersion: "0.17.4",
    id: "0005_decision_log_cheng_plan_id",
    touchedTables: ["decision_log"],
    sql: `alter table decision_log add column cheng_plan_id text;`,
    apply: (db) => {
      const hasColumn = db
        .prepare("PRAGMA table_info(decision_log)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "cheng_plan_id");
      if (!hasColumn) db.exec("alter table decision_log add column cheng_plan_id text;");
    },
  },
  {
    // S2：裁决 verdict 的 ChengPlan 引用同时落 trigger_events，作为行级审计事实。
    // additive 可空列；restore 删账本行但保留列时 apply 幂等重跑（同 0005）。
    appVersion: "0.17.5",
    id: "0006_trigger_events_cheng_plan_id",
    touchedTables: ["trigger_events"],
    sql: `alter table trigger_events add column cheng_plan_id text;`,
    apply: (db) => {
      const hasColumn = db
        .prepare("PRAGMA table_info(trigger_events)")
        .all()
        .some((entry) => (entry as { name?: string }).name === "cheng_plan_id");
      if (!hasColumn) db.exec("alter table trigger_events add column cheng_plan_id text;");
    },
  },
];
