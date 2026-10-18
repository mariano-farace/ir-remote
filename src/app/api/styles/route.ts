/**
 * `GET /api/styles` — the static style catalogue (FR-007).
 *
 * `guidance` is the instruction handed to the model and is removed here, at the
 * only boundary where styles leave the server (FR-011). The catalogue is read
 * from the seed through the read-only repository, so no verb other than GET
 * exists: there is no route to create, edit, or delete a style (FR-008).
 */

import { NextResponse } from "next/server";

import { dataResponse, errorResponse } from "@/lib/http/envelope";
import { getRepositories } from "@/lib/repositories/postgres";
import type { StyleSummary } from "@/lib/domain/types";

export async function GET(): Promise<NextResponse> {
  try {
    const styles = await getRepositories().styles.list();

    const summaries: StyleSummary[] = styles.map(({ id, name, description }) => ({
      id,
      name,
      description,
    }));

    return dataResponse(summaries);
  } catch (error) {
    console.error("GET /api/styles failed", error);

    return errorResponse("not_found", "The style catalogue could not be loaded.");
  }
}
