export function timelineTime(minutes) {
  const rounded = Math.round(minutes),
    day = Math.floor(rounded / 1440),
    minute = ((rounded % 1440) + 1440) % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}${day ? " (" + (day > 0 ? "+" : "") + day + "d)" : ""}`;
}
export function timelineColor(index) {
  return `hsl(${(index * 137.508 + 215) % 360} 48% 36%)`;
}
export function timelineModel(p, recipes) {
  const state = p.timeline || {},
    services = [],
    dishes = [],
    issues = [];
  let previous = -1,
    day = 0,
    colorIndex = 0;
  for (const [ci, course] of p.courses.entries()) {
    const courseName = course.name.trim() || `Course ${ci + 1}`,
      valid = /^\d{2}:\d{2}$/.test(course.time || "");
    const raw = valid
      ? Number(course.time.slice(0, 2)) * 60 + Number(course.time.slice(3))
      : null;
    const time =
      raw !== null &&
      Number(course.time.slice(0, 2)) < 24 &&
      Number(course.time.slice(3)) < 60
        ? raw
        : null;
    if (time !== null) {
      if (time < previous) day++;
      previous = time;
      services.push({
        id: course.id,
        name: courseName,
        time: day * 1440 + time,
      });
    }
    for (const dish of course.dishes) {
      const recipe =
          dish.recipe?.provider === "custom" ? recipes[dish.recipe.id] : null,
        color = timelineColor(colorIndex++),
        name = dish.name.trim() || "Untitled dish";
      const item = {
        id: dish.id,
        courseId: course.id,
        courseName,
        name,
        color,
        blocks: [],
      };
      dishes.push(item);
      const reason =
        time === null
          ? "Set a serving time in Planner."
          : !recipe
            ? "Attach a recipe."
            : !recipe.steps.length
              ? "Add recipe steps."
              : recipe.steps.some(
                    (s) =>
                      s.minutes == null ||
                      String(s.minutes).trim() === "" ||
                      !Number.isFinite(Number(s.minutes)) ||
                      Number(s.minutes) < 0,
                  )
                ? "Fill in missing or invalid step durations."
                : null;
      if (reason) {
        issues.push({ name, reason });
        continue;
      }
      const totalDuration = recipe.steps.reduce(
        (sum, step) => sum + Number(step.minutes),
        0,
      );
      if (
        !Number.isFinite(totalDuration) ||
        totalDuration > Number.MAX_SAFE_INTEGER / 4
      ) {
        issues.push({
          name,
          reason: "Step durations exceed the supported schedule range.",
        });
        continue;
      }
      const signature = JSON.stringify([
        recipe.id,
        recipe.steps.map((s) => [s.text, Number(s.minutes)]),
      ]);
      item.signature = signature;
      const edits = state.offsets?.[dish.id];
      const offsets = edits?.signature === signature ? edits.values : [];
      let start = day * 1440 + time - totalDuration;
      item.service = day * 1440 + time;
      item.blocks = recipe.steps.map((s, index) => {
        const duration = Number(s.minutes),
          offset = Number(offsets?.[index]) || 0;
        const block = {
          dishId: dish.id,
          courseId: course.id,
          dishName: name,
          color,
          index,
          text: s.text,
          duration,
          start: start + offset,
          end: start + offset + duration,
        };
        start += duration;
        return block;
      });
    }
  }
  const blocks = dishes.flatMap((d) => d.blocks),
    times = [
      ...services.map((s) => s.time),
      ...blocks.flatMap((b) => [b.start, b.end]),
    ];
  const min = times.length
      ? Math.floor(
          (times.reduce((value, time) => Math.min(value, time), Infinity) -
            20) /
            30,
        ) * 30
      : 660,
    max = times.length
      ? Math.ceil(
          (times.reduce((value, time) => Math.max(value, time), -Infinity) +
            20) /
            30,
        ) * 30
      : 780;
  return {
    dishes,
    services,
    issues,
    min,
    max: Math.max(max, min + 60),
    blocks,
  };
}
