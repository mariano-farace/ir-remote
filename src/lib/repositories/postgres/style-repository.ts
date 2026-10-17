/**
 * The read-only style catalogue (FR-007, FR-008).
 *
 * Deliberately has no create, update, or delete: styles are shipped content,
 * seeded by `db/seed/styles.sql`, and the constitution forbids the catalogue
 * becoming a user-editable table through an undocumented feature path.
 */

import type { StyleId } from "@/lib/domain/types";
import {
  RepositoryError,
  type StoredStyle,
  type StyleRepository,
} from "@/lib/repositories/types";

import { getPool } from "./pool";

interface StyleRow {
  id: string;
  name: string;
  description: string;
  guidance: string;
}

const STYLE_COLUMNS = "id, name, description, guidance";

function toStyle(row: StyleRow): StoredStyle {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    guidance: row.guidance,
  };
}

export class PostgresStyleRepository implements StyleRepository {
  /**
   * The whole catalogue in its declared presentation order. The first entry is
   * the default a newly created script takes (spec.md, Assumptions), so the
   * order is read from `display_order` rather than inferred from insertion.
   */
  async list(): Promise<readonly StoredStyle[]> {
    const result = await getPool().query<StyleRow>(
      `SELECT ${STYLE_COLUMNS} FROM styles ORDER BY display_order, id`,
    );

    return result.rows.map(toStyle);
  }

  async get(id: StyleId): Promise<StoredStyle> {
    const result = await getPool().query<StyleRow>(
      `SELECT ${STYLE_COLUMNS} FROM styles WHERE id = $1`,
      [id],
    );

    const row = result.rows[0];

    if (!row) {
      throw new RepositoryError("not_found", `No style exists with id "${id}"`);
    }

    return toStyle(row);
  }
}
