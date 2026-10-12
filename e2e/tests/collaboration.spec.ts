import { expect, test, type Page } from '@playwright/test';

type Box = { id: string; x: number; y: number; width: number; height: number };

/**
 * The rectangles the whiteboard has rendered. The canvas is drawn by Konva, which registers
 * itself as window.Konva; shape nodes carry the shape's id, while selection and resize handles
 * have none.
 */
function rectangles(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    type Node = { id(): string; x(): number; y(): number; width(): number; height(): number };
    const { Konva } = window as unknown as { Konva: { stages: { find(selector: string): Node[] }[] } };
    return Konva.stages[0]!
      .find('Rect')
      .filter((node) => node.id())
      .map((node) => ({ id: node.id(), x: node.x(), y: node.y(), width: node.width(), height: node.height() }));
  });
}

// The app has no accounts: a participant joins a room by choosing a display name.
async function joinAs(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your display name').fill(name);
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByRole('status', { name: 'Connection: Connected' })).toBeVisible();
}

test("the interviewer sees the candidate's drawing", async ({ browser }) => {
  // Separate contexts are separate people: no shared storage, cookies or seat tokens.
  const interviewer = await (await browser.newContext()).newPage();
  const candidate = await (await browser.newContext()).newPage();

  await test.step('interviewer creates an interview session and joins it', async () => {
    await interviewer.goto('/');
    await interviewer.getByLabel('Interview title').fill('Design a URL shortener');
    await interviewer.getByRole('button', { name: 'Create room' }).click();
    await expect(interviewer).toHaveURL(/\/r\/[\w-]+$/);
  });

  const joinLink = await test.step('interviewer copies the join link', async () => {
    return interviewer.getByLabel('Room link').inputValue();
  });

  await test.step('interviewer joins with an empty canvas', async () => {
    await joinAs(interviewer, 'Interviewer');
    expect(await rectangles(interviewer)).toEqual([]);
  });

  await test.step('candidate opens the link and joins', async () => {
    await candidate.goto(joinLink);
    await joinAs(candidate, 'Candidate');
  });

  const drawn = await test.step('candidate draws a rectangle', async () => {
    await candidate.getByRole('button', { name: 'Rectangle' }).click();
    const canvas = (await candidate.locator('.konvajs-content').boundingBox())!;
    const cx = canvas.x + canvas.width / 2;
    const cy = canvas.y + canvas.height / 2;
    await candidate.mouse.move(cx - 80, cy - 50);
    await candidate.mouse.down();
    await candidate.mouse.move(cx + 80, cy + 50, { steps: 10 });
    await candidate.mouse.up();
    await expect.poll(() => rectangles(candidate)).toHaveLength(1);
    return (await rectangles(candidate))[0]!;
  });

  await test.step("the rectangle appears on the interviewer's canvas", async () => {
    await expect.poll(() => rectangles(interviewer)).toEqual([drawn]);
  });
});
