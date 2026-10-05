/** Share expensive formatters within one synchronous render, never across renders. */
export function createReceivedAtFormatter() {
  let timeFormatter: Intl.DateTimeFormat | undefined;
  let dateFormatter: Intl.DateTimeFormat | undefined;

  return (receivedAt: string) => {
    const date = new Date(receivedAt);
    if (Number.isNaN(date.getTime())) return "";

    // Keep the existing local-calendar comparison and check now for each label.
    const isToday = date.toDateString() === new Date().toDateString();
    const formatter = isToday
      ? (timeFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }))
      : (dateFormatter ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }));
    return formatter.format(date);
  };
}

/** Single labels outside the inbox retain fresh locale/timezone resolution. */
export function formatReceivedAt(receivedAt: string) {
  return createReceivedAtFormatter()(receivedAt);
}
