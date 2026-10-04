/**
 * Deep links into the Drafting page: /drafting?project=&drawing=&sheet=&item=
 * opens a drawing (and sheet) and centres the item, switching project first
 * when the link names another one.
 */

export type DraftingTarget = {
  projectId?: string;
  drawingId: string;
  sheetId?: string;
  /** Document item id on the sheet (SheetItem.item_id), not the index row id. */
  itemId?: string;
};

export function draftingHref(target: DraftingTarget): string {
  const params = new URLSearchParams();
  if (target.projectId) params.set("project", target.projectId);
  params.set("drawing", target.drawingId);
  if (target.sheetId) params.set("sheet", target.sheetId);
  if (target.itemId) params.set("item", target.itemId);
  return `/drafting?${params.toString()}`;
}

export function parseDraftingTarget(params: URLSearchParams): DraftingTarget | null {
  const drawingId = params.get("drawing");
  if (!drawingId) return null;
  return {
    projectId: params.get("project") ?? undefined,
    drawingId,
    sheetId: params.get("sheet") ?? undefined,
    itemId: params.get("item") ?? undefined
  };
}
