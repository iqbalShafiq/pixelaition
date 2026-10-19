const keyFor = (taskId: string) => `pixelaition:task-seen:${taskId}`;

/** The editor was already opened after this task finished. */
export function taskSeen(taskId: string): boolean {
  try {
    return localStorage.getItem(keyFor(taskId)) === "1";
  } catch {
    return false;
  }
}

/** Remember that this visit counted, so the next open stays quiet. */
export function markTaskSeen(taskId: string): void {
  try {
    localStorage.setItem(keyFor(taskId), "1");
  } catch {
    // Private mode can refuse storage. The badge then shows again next time.
  }
}
