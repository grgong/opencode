import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { eq } from "drizzle-orm"
import path from "path"
import fs from "fs/promises"
import { readFileSync, readdirSync } from "fs"
import { JsonMigration } from "../../src/storage/json-migration"
import { Global } from "../../src/global"
import { ProjectTable } from "../../src/project/project.sql"
import { Project } from "../../src/project/project"
import { SessionTable, MessageTable, PartTable, TodoTable, PermissionTable } from "../../src/session/session.sql"
import { SessionShareTable } from "../../src/share/share.sql"

// Test fixtures
const fixtures = {
  project: {
    id: "proj_test123abc",
    name: "Test Project",
    worktree: "/test/path",
    vcs: "git" as const,
    sandboxes: [],
  },
  session: {
    id: "ses_test456def",
    projectID: "proj_test123abc",
    slug: "test-session",
    directory: "/test/path",
    title: "Test Session",
    version: "1.0.0",
    time: { created: 1700000000000, updated: 1700000001000 },
  },
  message: {
    id: "msg_test789ghi",
    sessionID: "ses_test456def",
    role: "user" as const,
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: 1700000000000 },
  },
  part: {
    id: "prt_testabc123",
    messageID: "msg_test789ghi",
    sessionID: "ses_test456def",
    type: "text" as const,
    text: "Hello, world!",
  },
}

// Helper to create test storage directory structure
async function setupStorageDir() {
  const storageDir = path.join(Global.Path.data, "storage")
  await fs.rm(storageDir, { recursive: true, force: true })
  await fs.mkdir(path.join(storageDir, "project"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session", "proj_test123abc"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "message", "ses_test456def"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "part", "msg_test789ghi"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session_diff"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "todo"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "permission"), { recursive: true })
  await fs.mkdir(path.join(storageDir, "session_share"), { recursive: true })
  // Create legacy marker to indicate JSON storage exists
  await Bun.write(path.join(storageDir, "migration"), "1")
  return storageDir
}

// Helper to create in-memory test database with schema
function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  // Apply schema migrations using drizzle migrate
  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  migrate(drizzle({ client: sqlite }), migrations)

  return sqlite
}

describe("JSON to SQLite migration", () => {
  let storageDir: string
  let sqlite: Database

  beforeEach(async () => {
    storageDir = await setupStorageDir()
    sqlite = createTestDb()
  })

  afterEach(async () => {
    sqlite.close()
    await fs.rm(storageDir, { recursive: true, force: true })
  })

  test("migrates project", async () => {
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/test/path",
        vcs: "git",
        name: "Test Project",
        time: { created: 1700000000000, updated: 1700000001000 },
        sandboxes: ["/test/sandbox"],
      }),
    )

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.projects).toBe(1)

    const db = drizzle({ client: sqlite })
    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe("proj_test123abc")
    expect(projects[0].worktree).toBe("/test/path")
    expect(projects[0].name).toBe("Test Project")
    expect(projects[0].sandboxes).toEqual(["/test/sandbox"])
  })

  test("migrates session with individual columns", async () => {
    // First create the project
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/test/path",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )

    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_test456def.json"),
      JSON.stringify({
        id: "ses_test456def",
        projectID: "proj_test123abc",
        slug: "test-session",
        directory: "/test/dir",
        title: "Test Session Title",
        version: "1.0.0",
        time: { created: 1700000000000, updated: 1700000001000 },
        summary: { additions: 10, deletions: 5, files: 3 },
        share: { url: "https://example.com/share" },
      }),
    )

    await JsonMigration.run(sqlite)

    const db = drizzle({ client: sqlite })
    const sessions = db.select().from(SessionTable).all()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe("ses_test456def")
    expect(sessions[0].project_id).toBe("proj_test123abc")
    expect(sessions[0].slug).toBe("test-session")
    expect(sessions[0].title).toBe("Test Session Title")
    expect(sessions[0].summary_additions).toBe(10)
    expect(sessions[0].summary_deletions).toBe(5)
    expect(sessions[0].share_url).toBe("https://example.com/share")
  })

  test("migrates messages and parts", async () => {
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_test456def.json"),
      JSON.stringify({ ...fixtures.session }),
    )
    await Bun.write(
      path.join(storageDir, "message", "ses_test456def", "msg_test789ghi.json"),
      JSON.stringify({ ...fixtures.message }),
    )
    await Bun.write(
      path.join(storageDir, "part", "msg_test789ghi", "prt_testabc123.json"),
      JSON.stringify({ ...fixtures.part }),
    )

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.messages).toBe(1)
    expect(stats?.parts).toBe(1)

    const db = drizzle({ client: sqlite })
    const messages = db.select().from(MessageTable).all()
    expect(messages.length).toBe(1)
    expect(messages[0].id).toBe("msg_test789ghi")

    const parts = db.select().from(PartTable).all()
    expect(parts.length).toBe(1)
    expect(parts[0].id).toBe("prt_testabc123")
  })

  test("skips orphaned sessions (no parent project)", async () => {
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_orphan.json"),
      JSON.stringify({
        id: "ses_orphan",
        projectID: "proj_nonexistent",
        slug: "orphan",
        directory: "/",
        title: "Orphan",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
      }),
    )

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.sessions).toBe(0)
  })

  test("is idempotent (running twice doesn't duplicate)", async () => {
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )

    await JsonMigration.run(sqlite)
    await JsonMigration.run(sqlite)

    const db = drizzle({ client: sqlite })
    const projects = db.select().from(ProjectTable).all()
    expect(projects.length).toBe(1) // Still only 1 due to onConflictDoNothing
  })

  test("migrates todos", async () => {
    // First create the project and session
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_test456def.json"),
      JSON.stringify({ ...fixtures.session }),
    )

    // Create todo file (named by sessionID, contains array of todos)
    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([
        {
          id: "todo_1",
          content: "First todo",
          status: "pending",
          priority: "high",
        },
        {
          id: "todo_2",
          content: "Second todo",
          status: "completed",
          priority: "medium",
        },
      ]),
    )

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.todos).toBe(2)

    const db = drizzle({ client: sqlite })
    const todos = db.select().from(TodoTable).orderBy(TodoTable.position).all()
    expect(todos.length).toBe(2)
    expect(todos[0].content).toBe("First todo")
    expect(todos[0].status).toBe("pending")
    expect(todos[0].priority).toBe("high")
    expect(todos[0].position).toBe(0)
    expect(todos[1].content).toBe("Second todo")
    expect(todos[1].position).toBe(1)
  })

  test("todos are ordered by position", async () => {
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_test456def.json"),
      JSON.stringify({ ...fixtures.session }),
    )

    await Bun.write(
      path.join(storageDir, "todo", "ses_test456def.json"),
      JSON.stringify([
        { content: "Third", status: "pending", priority: "low" },
        { content: "First", status: "pending", priority: "high" },
        { content: "Second", status: "in_progress", priority: "medium" },
      ]),
    )

    await JsonMigration.run(sqlite)

    const db = drizzle({ client: sqlite })
    const todos = db.select().from(TodoTable).orderBy(TodoTable.position).all()

    expect(todos.length).toBe(3)
    expect(todos[0].content).toBe("Third")
    expect(todos[0].position).toBe(0)
    expect(todos[1].content).toBe("First")
    expect(todos[1].position).toBe(1)
    expect(todos[2].content).toBe("Second")
    expect(todos[2].position).toBe(2)
  })

  test("migrates permissions", async () => {
    // First create the project
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )

    // Create permission file (named by projectID, contains array of rules)
    const permissionData = [
      { permission: "file.read", pattern: "/test/file1.ts", action: "allow" as const },
      { permission: "file.write", pattern: "/test/file2.ts", action: "ask" as const },
      { permission: "command.run", pattern: "npm install", action: "deny" as const },
    ]
    await Bun.write(path.join(storageDir, "permission", "proj_test123abc.json"), JSON.stringify(permissionData))

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.permissions).toBe(1)

    const db = drizzle({ client: sqlite })
    const permissions = db.select().from(PermissionTable).all()
    expect(permissions.length).toBe(1)
    expect(permissions[0].project_id).toBe("proj_test123abc")
    expect(permissions[0].data).toEqual(permissionData)
  })

  test("migrates session shares", async () => {
    // First create the project and session
    await Bun.write(
      path.join(storageDir, "project", "proj_test123abc.json"),
      JSON.stringify({
        id: "proj_test123abc",
        worktree: "/",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      }),
    )
    await Bun.write(
      path.join(storageDir, "session", "proj_test123abc", "ses_test456def.json"),
      JSON.stringify({ ...fixtures.session }),
    )

    // Create session share file (named by sessionID)
    await Bun.write(
      path.join(storageDir, "session_share", "ses_test456def.json"),
      JSON.stringify({
        id: "share_123",
        secret: "supersecretkey",
        url: "https://share.example.com/ses_test456def",
      }),
    )

    const stats = await JsonMigration.run(sqlite)

    expect(stats?.shares).toBe(1)

    const db = drizzle({ client: sqlite })
    const shares = db.select().from(SessionShareTable).all()
    expect(shares.length).toBe(1)
    expect(shares[0].session_id).toBe("ses_test456def")
    expect(shares[0].id).toBe("share_123")
    expect(shares[0].secret).toBe("supersecretkey")
    expect(shares[0].url).toBe("https://share.example.com/ses_test456def")
  })
})
