/**
 * THE WORKED EXAMPLE. Copy this file for your own import.
 *
 * A staff roster: a name, an email, a start date, a team. It is the
 * shape almost every "let them upload a spreadsheet" ticket turns out to
 * be, and everything in it that is not the table name is a decision you
 * will have to make too.
 *
 * To build your own import:
 *
 *   1. Copy this file to src/services/import/examples/<yours>.ts (or
 *      anywhere; the folder is a convention, not a rule).
 *   2. Change `name`, `label`, `description`, and the `fields` list.
 *   3. Point `loadExisting` and `upsertRow` at your table.
 *   4. Register it from main.ts, next to `registerPeopleImport()`.
 *   5. Delete this file, its table, and its migration.
 *
 * You do not touch the wizard, the parser, the mapper, the preview, the
 * routes, or the UI. That is the whole point.
 *
 * THE FOUR DECISIONS, and how this file makes them:
 *
 *   ALIASES. `email` needs none: the fuzzy matcher already folds case,
 *   spaces and punctuation, so "E-Mail" and "Work Email " land on it.
 *   Aliases are for genuinely different WORDS -- "staff no", "dept".
 *
 *   THE NAME SPLIT. Most rosters have one "Name" column and most tables
 *   have two. `fullName` is `inputOnly`, so it is mappable and validated
 *   but never written; `splitFullName` fills first and last from it, and
 *   an explicit "First name" column always wins over the split.
 *
 *   IDENTITY. `matchBy: [["email"], ["firstName", "lastName"]]` -- email
 *   first because it is the strong key, exact name pair as the fallback
 *   for rows that have no email. This is what makes a second import of
 *   the same file update thirty people instead of creating thirty more.
 *
 *   SCOPE. Both handlers filter by the organizationId they are handed.
 *   The framework does not do it for them (CWE-639).
 */

import { db } from "@/db/client.ts";
import {
  findImportDefinition,
  type ImportDefinition,
  registerImportDefinition,
  splitFullName,
} from "../definitions.ts";

export const PEOPLE_IMPORT_NAME = "people";

export const peopleImportDefinition: ImportDefinition = {
  name: PEOPLE_IMPORT_NAME,
  label: "People",
  description:
    "A staff roster: name, email, start date and team. Re-importing the same file updates " +
    "the people already here rather than adding them twice.",

  fields: [
    {
      key: "fullName",
      label: "Full name",
      kind: "text",
      inputOnly: true,
      // Only words the matcher cannot already reach. "Full Name" and
      // "full_name" both squash to "fullname" on their own.
      aliases: ["name", "employee", "employee name", "staff member", "person"],
      help: "Split into first and last name. An explicit first-name column wins over this.",
      maxLength: 200,
    },
    {
      key: "firstName",
      label: "First name",
      kind: "text",
      required: true,
      aliases: ["first", "given name", "forename"],
      maxLength: 100,
    },
    {
      key: "lastName",
      label: "Last name",
      kind: "text",
      aliases: ["last", "surname", "family name"],
      maxLength: 100,
    },
    {
      key: "email",
      label: "Email",
      kind: "email",
      required: true,
      aliases: ["work email", "email address", "contact"],
    },
    {
      key: "startDate",
      label: "Start date",
      kind: "date",
      aliases: ["start", "hire date", "joined", "began"],
      // Month-first, because that is what a US-locale export writes and
      // 3/4/2026 cannot tell you on its own. Flip this to "dmy" for a
      // roster that comes out of a European system.
      dateOrder: "mdy",
    },
    {
      key: "team",
      label: "Team",
      kind: "enum",
      options: ["Engineering", "Sales", "Support", "Operations"],
      aliases: ["department", "dept", "group", "division"],
      help: "Anything outside the list is an error, not a new team.",
    },
  ],

  derive: [splitFullName({ from: "fullName", first: "firstName", last: "lastName" })],

  matchBy: [["email"], ["firstName", "lastName"]],

  /**
   * Everyone this org already has.
   *
   * The roster is small, so it loads whole. For a large table, narrow it
   * with the rows you were handed:
   *
   *   .where("email", "in", rows.map((r) => r.email).filter(Boolean))
   *
   * If you do narrow, cover EVERY matchBy tuple. An email-only WHERE
   * would make the name fallback silently never match, and every
   * re-import of a person with no email address would create a second
   * copy of them -- the exact failure `matchBy` exists to prevent.
   */
  async loadExisting({ organizationId }) {
    const rows = await db
      .selectFrom("import_demo_people")
      .select(["id", "firstName", "lastName", "email"])
      // Org-scoped in the WHERE clause. The route gate is not the
      // authorization check (CWE-639).
      .where("organizationId", "=", organizationId)
      .limit(5000)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      values: {
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      },
    }));
  },

  /**
   * One row, inside the framework's transaction.
   *
   * `trx`, never `db`: a write on the outer connection would not roll
   * back with the rest of the import, so a failure halfway through would
   * leave part of the file applied and no record of which part.
   */
  async upsertRow({ trx, organizationId, values, existingId }) {
    const row = {
      firstName: String(values.firstName),
      lastName: values.lastName === null ? null : String(values.lastName),
      email: String(values.email),
      startDate: values.startDate === null ? null : String(values.startDate),
      team: values.team === null ? null : String(values.team),
    };

    if (existingId) {
      const updated = await trx
        .updateTable("import_demo_people")
        .set(row)
        .where("id", "=", existingId)
        // Org-scoped here too. An id from another workspace updates
        // nothing rather than somebody else's row.
        .where("organizationId", "=", organizationId)
        .returning(["id"])
        .executeTakeFirst();
      if (updated) return { id: updated.id };
      // The record vanished between the preview and the commit. Falling
      // through to an insert is right: the person is in the file, so
      // they belong in the table.
    }

    const inserted = await trx
      .insertInto("import_demo_people")
      .values({ ...row, organizationId })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    return { id: inserted.id };
  },

  sampleCsv() {
    return [
      "Full Name,Work E-Mail,Start Date,Department",
      "Ana Ruiz,ana.ruiz@example.com,3/4/2026,Engineering",
      "Bo Lindqvist,bo@example.com,2026-04-01,Sales",
      "Chidi Okonjo,chidi@example.com,15 May 2026,Support",
      "",
    ].join("\n");
  },
};

/**
 * Register the example. Called from main.ts, and from any test that
 * needs it.
 *
 * Idempotent, unlike `registerImportDefinition` itself. Registration
 * throws on a duplicate name, which is right for an app's own
 * definitions (two imports answering to one name would make one of them
 * unreachable) and wrong here, where several test files each want the
 * example present and none of them can know who ran first.
 */
export function registerPeopleImport(): void {
  if (findImportDefinition(PEOPLE_IMPORT_NAME)) return;
  registerImportDefinition(peopleImportDefinition);
}
