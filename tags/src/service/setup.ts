import { ApiError, type AuthContext, assertPermanentKey } from "@afs/shared";
import { analyticsBindingAvailable } from "../destinations/analytics";
import type { Bindings } from "../env";
import { destinationInfos, draftConfig, getContainerRow } from "./containers";
import { createDestination, DESTINATION_ACTIONS, presentDestination } from "./destinations";
import { buildRecipe, deliveryGaps, type RecipeInput, recipeNextSteps, withGaps } from "./recipe";
import { putDraft } from "./versions";

/**
 * setup_conversion_tracking: write the draft + destinations from plain inputs, then validate. An
 * OAuth access token gets the draft but no destinations (they'd outlive it): each is reported in
 * destination_errors as temporary_credential.
 *
 * A conversion gets server: true only when a destination will really receive it (existing,
 * created now, or the analytics app over the ANALYTICS binding); when a planned destination
 * can't be created the draft is rebuilt without it. Validation warnings that still mean a
 * conversion won't be delivered are listed in missing[] (once: a platform's missing server
 * credential already says it), and ready_to_publish is false until there are none.
 */
export async function applyRecipe(env: Bindings, auth: AuthContext, containerId: string, input: RecipeInput, origins: string[] = []) {
  const { accountId } = auth;
  const row = await getContainerRow(env, accountId, containerId);
  const existing = (await destinationInfos(env, containerId)).filter((d) => d.enabled).map((d) => d.type);
  const base = { analyticsBinding: analyticsBindingAvailable(env), existingDestinations: existing };
  const planned = buildRecipe(input, draftConfig(row), base);
  const created: unknown[] = [];
  const createdTypes: string[] = [];
  const failed: string[] = [];
  const destinationErrors: unknown[] = [];
  for (const d of planned.destinations) {
    try {
      assertPermanentKey(auth, DESTINATION_ACTIONS.add);
      const r = await createDestination(env, accountId, containerId, { type: d.type, name: d.name, credentials: d.credentials }, origins);
      created.push({ ...presentDestination(r.row), existing: r.existing });
      if (r.row.enabled) createdTypes.push(d.type);
    } catch (e) {
      failed.push(d.type);
      destinationErrors.push({ type: d.type, error: e instanceof ApiError ? e.toJSON().error : { message: String(e) } });
    }
  }
  const built = failed.length
    ? buildRecipe(input, draftConfig(row), { ...base, available: [...existing, ...createdTypes], failed })
    : planned;
  const written = await putDraft(env, accountId, containerId, built.config);
  const gaps = deliveryGaps(written.validation, written.config);
  const missing = withGaps(built.missing, gaps);
  return {
    container_id: containerId,
    draft_revision: written.row.draft_revision,
    draft: written.config,
    validation: written.validation,
    destinations: created,
    destination_errors: destinationErrors,
    missing,
    notes: built.notes,
    // Valid AND every conversion reaches each platform it targets (no delivery gap warnings).
    ready_to_publish: written.validation.valid && gaps.length === 0,
    next_steps: recipeNextSteps(containerId, written.validation, missing, written.row.live_version != null, gaps),
  };
}
