import { ApiError, type AuthContext, assertPermanentKey } from "@afs/shared";
import type { Bindings } from "../env";
import { draftConfig, getContainerRow } from "./containers";
import { createDestination, DESTINATION_ACTIONS, presentDestination } from "./destinations";
import { buildRecipe, type RecipeInput, recipeNextSteps } from "./recipe";
import { putDraft } from "./versions";

/**
 * setup_conversion_tracking: write the draft + destinations from plain inputs, then validate. An
 * OAuth access token gets the draft but no destinations (they'd outlive it): each is reported in
 * destination_errors as temporary_credential.
 */
export async function applyRecipe(env: Bindings, auth: AuthContext, containerId: string, input: RecipeInput, origins: string[] = []) {
  const { accountId } = auth;
  const row = await getContainerRow(env, accountId, containerId);
  const built = buildRecipe(input, draftConfig(row));
  const created: unknown[] = [];
  const destinationErrors: unknown[] = [];
  for (const d of built.destinations) {
    try {
      assertPermanentKey(auth, DESTINATION_ACTIONS.add);
      const r = await createDestination(env, accountId, containerId, { type: d.type, name: d.name, credentials: d.credentials }, origins);
      created.push({ ...presentDestination(r.row), existing: r.existing });
    } catch (e) {
      destinationErrors.push({ type: d.type, error: e instanceof ApiError ? e.toJSON().error : { message: String(e) } });
    }
  }
  const written = await putDraft(env, accountId, containerId, built.config);
  return {
    container_id: containerId,
    draft_revision: written.row.draft_revision,
    draft: written.config,
    validation: written.validation,
    destinations: created,
    destination_errors: destinationErrors,
    missing: built.missing,
    notes: built.notes,
    ready_to_publish: written.validation.valid,
    next_steps: recipeNextSteps(containerId, written.validation, built.missing, written.row.live_version != null),
  };
}
