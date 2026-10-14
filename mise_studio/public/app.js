import { loadWorkspace } from "./storage.js";
import { timelineTime, timelineModel } from "./timeline-model.js";
import {
  bindRecipeImport,
  bindRecipeSearch,
  matchSavedRecipes,
  recipeSearchMarkup,
} from "./recipe-import.js";
const app = document.querySelector("#app");
const storageKey = "mise-studio-data-v2";
let projects = Object.create(null),
  savedRecipes = Object.create(null),
  recipeDrafts = Object.create(null),
  project,
  storageFailed = false;
let storageReadFailed = false,
  lastStored = null,
  storageConflict = false;
let recipeBindings = [];
function disposeRecipeBindings() {
  for (const binding of recipeBindings) binding?.dispose?.();
  recipeBindings = [];
}
try {
  lastStored = localStorage.getItem(storageKey);
  const data = loadWorkspace(localStorage, storageKey);
  projects = data.projects;
  savedRecipes = data.recipes;
  recipeDrafts = data.drafts;
} catch {
  storageFailed = true;
  storageReadFailed = true;
}
const snapshot = () =>
  JSON.stringify({ schemaVersion: 3, projects, recipes: savedRecipes, drafts: recipeDrafts });
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function persistSnapshot(value) {
  if (storageReadFailed) throw new Error("Saved data could not be loaded");
  if (localStorage.getItem(storageKey) !== lastStored) {
    storageConflict = true;
    throw new Error("Data changed in another tab");
  }
  if (value !== lastStored) {
    if (lastStored && !JSON.parse(lastStored).schemaVersion && !localStorage.getItem(storageKey + "-before-v3"))
      localStorage.setItem(storageKey + "-before-v3", lastStored);
    localStorage.setItem(storageKey, value);
  }
  lastStored = value;
  storageConflict = false;
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function save() {
  try {
    persistSnapshot(snapshot());
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
  const status = document.querySelector("#save-status");
  if (status)
    status.textContent = storageFailed
      ? storageConflict
        ? "Changed in another tab · keep this tab open"
        : "Unable to save · keep this tab open"
      : location.pathname.startsWith("/recipe/")
        ? "Draft saved on this device"
        : "Saved on this device";
}
function createProject() {
  const id = crypto.randomUUID();
  projects[id] = { id, name: "", guests: 4, date: today(), courses: [] };
  save();
  history.pushState({}, "", "/project/" + id);
  render();
  return projects[id];
}
function deleteProject(id) {
  const selected = projects[id];
  if (
    !selected ||
    !confirm(
      `Delete "${selected.name.trim() || "Untitled project"}" and all its courses and dishes? This cannot be undone.`,
    )
  )
    return;
  const remaining = Object.assign(Object.create(null), projects);
  delete remaining[id];
  try {
    persistSnapshot(
      JSON.stringify({
        projects: remaining,
        recipes: savedRecipes,
        drafts: recipeDrafts,
      }),
    );
  } catch {
    alert("Unable to delete this project. Please try again.");
    return;
  }
  projects = remaining;
  if (project?.id === id) history.replaceState({}, "", "/");
  render();
  document.querySelector("#new-project")?.focus();
}
function home() {
  const recipesTab = location.pathname === "/recipes";
  const list = Object.values(projects).filter(
    (p) => p && /^[a-zA-Z0-9-]+$/.test(p.id) && Array.isArray(p.courses),
  );
  app.innerHTML = `<main class="home home-projects"><div class="home-heading"><h1>Mise Studio<span class="period">.</span></h1><div class="home-recipe-actions"><button class="primary" id="${recipesTab ? "new-recipe" : "new-project"}"><span aria-hidden="true">＋</span> New ${recipesTab ? "recipe" : "project"}</button></div></div><nav class="project-tabs home-tabs" aria-label="Home"><a href="/" ${!recipesTab ? 'aria-current="page"' : ""}>Projects</a><a href="/recipes" ${recipesTab ? 'aria-current="page"' : ""}>Saved recipes</a></nav>${storageReadFailed ? '<p class="storage-error" role="alert">Saved data could not be loaded. Existing data has been preserved; saving is disabled. Keep this tab open and check browser storage before continuing.</p>' : ""}<section class="saved-projects">${recipesTab ? libraryMarkup() : `<h2>Your projects</h2>${list.length ? `<div class="project-grid">${list.map((p) => `<article class="project-card-shell"><a class="project-card" href="/project/${p.id}"><span class="eyebrow">${esc(p.date || "Date not set")}</span><h3>${esc(p.name.trim() || "Untitled project")}</h3><div class="project-card-bottom"><span>${esc(p.guests)} ${p.guests === 1 ? "guest" : "guests"} · ${p.courses.length} ${p.courses.length === 1 ? "course" : "courses"}</span><span aria-hidden="true">↗</span></div></a><button class="delete-button card-delete" data-delete-project="${p.id}" aria-label="Delete ${esc(p.name || "Untitled project")}">Delete</button></article>`).join("")}</div>` : '<div class="empty"><h3>A place for your next gathering.</h3><p>Create a project to begin planning.</p></div>'}`}</section></main>`;
  if (recipesTab) {
    document.querySelector("#new-recipe").onclick = () => startRecipe();
    document.querySelector("#library-results").onclick = e => { if(e.target.closest("#new-recipe-card")) startRecipe(); };
    bindLibrarySearch();
  } else {
    document.querySelector("#new-project").onclick = createProject;
    list.forEach((p) => {
      document.querySelector(`[data-delete-project="${p.id}"]`).onclick = () =>
        deleteProject(p.id);
    });
  }
}
function addDish(course, afterId) {
  const dish = { id: crypto.randomUUID(), name: "" };
  const index = afterId
    ? course.dishes.findIndex((d) => d.id === afterId) + 1
    : course.dishes.length;
  course.dishes.splice(index, 0, dish);
  save();
  drawCourses();
  document.querySelector(`[data-dish="${dish.id}"]`).focus();
}
function addCourse() {
  const c = { id: crypto.randomUUID(), name: "", time: "", dishes: [] };
  project.courses.push(c);
  save();
  drawCourses();
  document.querySelector(`[data-course="${c.id}"] .course-name`).focus();
}
function moveCourse(id, index) {
  const from = project.courses.findIndex((c) => c.id === id);
  if (
    from < 0 ||
    index < 0 ||
    index >= project.courses.length ||
    from === index
  )
    return;
  const [course] = project.courses.splice(from, 1);
  project.courses.splice(index, 0, course);
  save();
  drawCourses();
  document.querySelector(`[data-course="${id}"] .grip`).focus();
  document.querySelector("#announcement").textContent =
    `${course.name || "Course"} moved to position ${index + 1}.`;
}
function editor() {
  app.innerHTML = `<header class="topbar"><a class="brand" href="/">Mise Studio<span class="period">.</span></a><div class="save-controls"><span id="save-status" role="status">${storageFailed ? "Unable to save · keep this tab open" : "Saved on this device"}</span><button class="delete-button" id="delete-project">Delete</button><button class="primary save-button" id="save-project">Save</button></div></header>
  <main class="workspace"><a class="back" href="/">← <span>Home</span></a><div class="page-heading"><div class="eyebrow">THE PLAN</div><h1>Your next gathering<span class="period">.</span></h1></div>
  <div class="project-tabs" role="tablist" aria-label="Project workspace"><button id="planner-tab" role="tab" aria-controls="planner-panel" aria-selected="true">Planner</button><button id="recipes-tab" role="tab" aria-controls="recipes-panel" aria-selected="false" tabindex="-1">Recipes</button><button id="ingredients-tab" role="tab" aria-controls="ingredients-panel" aria-selected="false" tabindex="-1">Ingredients</button><button id="timeline-tab" role="tab" aria-controls="timeline-panel" aria-selected="false" tabindex="-1">Timeline</button></div><div id="planner-panel" role="tabpanel" aria-labelledby="planner-tab"><section class="parameters" aria-label="Project parameters"><label class="name-field">Project name<input id="project-name" type="text" maxlength="120" placeholder="e.g. Sunday supper" value="${esc(project.name)}"></label><label>Guests<input id="guest-count" type="number" min="1" max="999" step="1" value="${project.guests}" required></label><label>Date<input id="project-date" type="date" value="${esc(project.date)}" required></label></section>
  <section class="menu" aria-labelledby="courses-heading"><div class="section-heading"><h2 id="courses-heading">Courses <span id="course-count"></span></h2><span class="reorder-hint">Drag to arrange your menu</span></div><div id="courses"></div><button id="add-course" class="add-course">＋ <span>Add course</span></button></section><div class="finalize-row"><p id="planner-message" role="status"></p><button class="primary" id="finalize">Finalize →</button></div></div><section id="recipes-panel" role="tabpanel" aria-labelledby="recipes-tab" hidden></section><div class="finalize-row" id="recipe-continue-row" hidden><button class="primary" id="continue-ingredients">Continue →</button></div><section id="ingredients-panel" role="tabpanel" aria-labelledby="ingredients-tab" hidden></section><section id="timeline-panel" role="tabpanel" aria-labelledby="timeline-tab" hidden></section><div id="announcement" class="sr-only" aria-live="polite"></div></main>`;
  document.querySelector("#project-name").oninput = (e) => {
    project.name = e.target.value;
    save();
  };
  document.querySelector("#guest-count").oninput = (e) => {
    if (e.target.checkValidity()) {
      project.guests = Number(e.target.value);
      save();
    }
  };
  document.querySelector("#guest-count").onblur = (e) => {
    if (!e.target.checkValidity()) {
      e.target.reportValidity();
      e.target.value = project.guests;
    }
  };
  document.querySelector("#project-date").oninput = (e) => {
    if (e.target.value && e.target.checkValidity()) {
      project.date = e.target.value;
      save();
    }
  };
  document.querySelector("#project-date").onblur = (e) => {
    if (!e.target.value) e.target.value = project.date;
  };
  document.querySelector("#save-project").onclick = () => {
    save();
    if (!storageFailed)
      document.querySelector("#save-status").textContent = "Project saved";
  };
  document.querySelector("#delete-project").onclick = () =>
    deleteProject(project.id);
  document.querySelector("#add-course").onclick = addCourse;
  drawCourses();
  document.querySelector("#planner-tab").onclick = () => setTab("planner");
  document.querySelector("#recipes-tab").onclick = () => setTab("recipes");
  document.querySelector("#timeline-tab").onclick = () => setTab("timeline");
  document.querySelector("#ingredients-tab").onclick = () =>
    setTab("ingredients");
  document.querySelector("#continue-ingredients").onclick = () =>
    setTab("ingredients");
  document.querySelector("#finalize").onclick = () => {
    const dishes = allDishes();
    if (!dishes.length || dishes.some((x) => !x.dish.name.trim())) {
      document.querySelector("#planner-message").textContent = dishes.length
        ? "Name each dish before finalizing your plan."
        : "Add at least one dish before finalizing your plan.";
      return;
    }
    project.recipeDishId =
      dishes.find((x) => !attachedRecipe(x.dish))?.dish.id || dishes[0].dish.id;
    setTab("recipes");
  };
  for (const name of ["planner", "recipes", "ingredients", "timeline"])
    document.querySelector("#" + name + "-tab").onkeydown = (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const tabs = ["planner", "recipes", "ingredients", "timeline"];
        const next =
          e.key === "Home"
            ? "planner"
            : e.key === "End"
              ? "timeline"
              : tabs[
                  (tabs.indexOf(name) + (e.key === "ArrowRight" ? 1 : 3)) % 4
                ];
        setTab(next);
        document.querySelector("#" + next + "-tab").focus();
      }
    };
  setTab(project.activeTab || "planner", false);
}
function drawCourses() {
  document.querySelector("#course-count").textContent = String(
    project.courses.length,
  ).padStart(2, "0");
  document.querySelector(".reorder-hint").hidden = project.courses.length < 2;
  document.querySelector("#courses").innerHTML = project.courses.length
    ? project.courses
        .map(
          (c, i) =>
            `<article class="course" data-course="${c.id}"><div class="course-top"><button class="grip" aria-label="Drag to reorder course ${i + 1}" title="Drag to reorder"><svg width="16" height="24" viewBox="0 0 16 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="6" r="1.5"/><circle cx="11" cy="6" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="12" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/></svg></button><div class="course-title"><label for="name-${c.id}" class="eyebrow">COURSE ${String(i + 1).padStart(2, "0")}</label><input class="course-name" id="name-${c.id}" maxlength="120" placeholder="Course name" value="${esc(c.name)}"></div><label class="serve-label" for="time-${c.id}">Serve at<input class="course-time" id="time-${c.id}" type="time" value="${esc(c.time)}"></label><div class="course-actions"><button data-action="remove" aria-label="Remove course ${i + 1}" title="Remove course">×</button></div></div><div class="dishes">${c.dishes.map((d, j) => `<div class="dish"><span class="dish-marker" aria-hidden="true"></span><input aria-label="Dish ${j + 1} in course ${i + 1}" placeholder="Dish name" maxlength="160" data-dish="${d.id}" value="${esc(d.name)}"><button data-remove-dish="${d.id}" class="icon-button" aria-label="Remove dish ${j + 1}" title="Remove dish">×</button></div>`).join("")}<button class="add-dish">＋ <span>Add dish</span></button></div></article>`,
        )
        .join("")
    : `<div class="empty"><span class="empty-number" aria-hidden="true">01</span><h3>A good meal starts with a first course.</h3><p>Add a course, then fill it with dishes.</p></div>`;
  document.querySelectorAll("[data-course]").forEach((card, i) => {
    const c = project.courses[i];
    card.querySelector(".course-name").oninput = (e) => {
      c.name = e.target.value;
      save();
    };
    card.querySelector(".course-time").oninput = (e) => {
      c.time = e.target.value;
      save();
    };
    card.querySelector(".add-dish").onclick = () => addDish(c);
    card.querySelectorAll("[data-dish]").forEach((input) => {
      input.oninput = (e) => {
        const dish = c.dishes.find((d) => d.id === input.dataset.dish);
        if (
          dish.name.trim().toLowerCase() !== e.target.value.trim().toLowerCase()
        ) {
          delete dish.recipe;
          delete dish.recipeSkipped;
        }
        dish.name = e.target.value;
        save();
      };
      const dish = c.dishes.find((d) => d.id === input.dataset.dish);
      let original = JSON.parse(JSON.stringify(dish));
      input.onfocus = () => {
        original = JSON.parse(JSON.stringify(dish));
      };
      input.onkeydown = (e) => {
        if (e.key === "Escape" && !e.isComposing) {
          e.preventDefault();
          if (!original.name.trim()) {
            c.dishes = c.dishes.filter((d) => d.id !== dish.id);
          } else {
            delete dish.recipe;
            delete dish.recipeSkipped;
            Object.assign(dish, original);
          }
          save();
          drawCourses();
          document
            .querySelector('[data-course="' + c.id + '"] .add-dish')
            .focus();
          return;
        }
        if (e.key !== "Enter" || e.isComposing || e.repeat) return;
        e.preventDefault();
        addDish(c, input.dataset.dish);
      };
    });
    card.querySelectorAll("[data-remove-dish]").forEach((b) => {
      b.onclick = () => {
        c.dishes = c.dishes.filter((d) => d.id !== b.dataset.removeDish);
        save();
        drawCourses();
        document.querySelector(`[data-course="${c.id}"] .add-dish`).focus();
      };
    });
    card.querySelector('[data-action="remove"]').onclick = () => {
      if (
        (c.name || c.dishes.length) &&
        !confirm(`Remove ${c.name || "this course"} and its dishes?`)
      )
        return;
      project.courses.splice(i, 1);
      save();
      drawCourses();
      document.querySelector("#add-course").focus();
    };
    const grip = card.querySelector(".grip");
    grip.onpointerdown = (e) => {
      if (e.button !== 0 || project.courses.length < 2) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
      let target = i;
      const cards = [...document.querySelectorAll("[data-course]")];
      grip.onpointermove = (event) => {
        const y = event.clientY,
          remaining = cards.filter((el) => el !== card);
        target = remaining.filter((el) => {
          const r = el.getBoundingClientRect();
          return y > r.top + r.height / 2;
        }).length;
        cards.forEach((el) => el.classList.remove("drop-before", "drop-after"));
        if (target < remaining.length)
          remaining[target].classList.add("drop-before");
        else remaining.at(-1)?.classList.add("drop-after");
        if (y > window.innerHeight - 70) window.scrollBy(0, 14);
        else if (y < 80) window.scrollBy(0, -14);
      };
      const finish = (event) => {
        grip.onpointermove = null;
        grip.onpointerup = null;
        grip.onpointercancel = null;
        cards.forEach((el) =>
          el.classList.remove("dragging", "drop-before", "drop-after"),
        );
        if (grip.hasPointerCapture(e.pointerId))
          grip.releasePointerCapture(e.pointerId);
        if (event.type !== "pointercancel") moveCourse(c.id, target);
      };
      grip.onpointerup = finish;
      grip.onpointercancel = finish;
    };
  });
}
function render() {
  disposeRecipeBindings();
  const recipePath = location.pathname.match(
    /^\/recipe\/(?:new|edit)\/([a-zA-Z0-9-]+)\/?$/,
  );
  if (recipePath) {
    project = null;
    showRecipeEditor(recipePath[1]);
    return;
  }

  const id = location.pathname.match(/^\/project\/([a-zA-Z0-9-]+)\/?$/)?.[1];
  if (!id) {
    project = null;
    home();
    return;
  }
  project = projects[id];
  if (!project || !Array.isArray(project.courses)) {
    app.innerHTML =
      '<main class="home"><h1>Project not found.</h1><a class="primary" href="/">Back to home</a></main>';
    return;
  }
  editor();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (
    a &&
    (a.getAttribute("href") === "/" ||
      a.getAttribute("href") === "/recipes" ||
      a.getAttribute("href").startsWith("/project/") ||
      a.getAttribute("href").startsWith("/recipe/")) &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    e.button === 0
  ) {
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    render();
    window.scrollTo(0, 0);
  }
});
window.addEventListener("popstate", render);
render();
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  for (const tool of [
    {
      name: "create_project",
      description: "Create a new local meal project and open its editor.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute(input) {
        if (!input || Object.keys(input).length)
          throw new Error("Expected an empty object");
        const p = createProject();
        return { id: p.id, url: location.href };
      },
    },
    {
      name: "read_project",
      description: "Read the currently open meal project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        if (!input || Object.keys(input).length)
          throw new Error("Expected an empty object");
        if (!project) throw new Error("Open a project first");
        return JSON.parse(JSON.stringify(project));
      },
    },
  ]) {
    try {
      Promise.resolve(
        document.modelContext.registerTool(tool, { signal: lifecycle.signal }),
      ).catch(() => {});
    } catch {}
  }
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
function allDishes() {
  return project.courses.flatMap((course, index) =>
    course.dishes.map((dish) => ({
      dish,
      courseName: course.name.trim() || `Course ${index + 1}`,
    })),
  );
}
function setTab(tab, persist = true) {
  disposeRecipeBindings();
  project.activeTab = ["recipes", "ingredients", "timeline"].includes(tab)
    ? tab
    : "planner";
  for (const name of ["planner", "recipes", "ingredients", "timeline"]) {
    const active = name === project.activeTab;
    const button = document.querySelector("#" + name + "-tab");
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    document.querySelector("#" + name + "-panel").hidden = !active;
  }
  if (persist) save();
  document.querySelector("#recipe-continue-row").hidden =
    project.activeTab !== "recipes";
  if (project.activeTab === "recipes") drawRecipes();
  if (project.activeTab === "ingredients") drawIngredients();
  if (project.activeTab === "timeline") drawTimeline();
}
function navigate(path) {
  history.pushState({}, "", path);
  render();
  window.scrollTo(0, 0);
}
function recipeMeta(r) {
  return `${recipeYield(r)} · ${r.steps.some(s => s.minutes == null || String(s.minutes).trim() === "") ? "Needs timing review" : `${r.steps.reduce((sum, s) => sum + Number(s.minutes), 0)} min total steps`}`;
}
function recipeYield(r) {
  return r.servings == null || String(r.servings).trim() === "" ? esc(r.importMetadata?.yield?.raw || "Yield not supplied") : `Serves ${esc(r.servings)}`;
}
function recipeSource(r) {
  const source = r.importMetadata?.source;
  const value = source?.url || r.sourceUrl;
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  const credit = [source?.author, source?.publisher || url.hostname].filter(Boolean).join(" · ");
  return `<p class="recipe-source">From <a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(credit)}</a>${r.importMetadata?.yield?.raw ? ` · ${esc(r.importMetadata.yield.raw)}` : ""}</p>`;
}
function knownTags() {
  return [
    ...new Map(
      Object.values(savedRecipes)
        .flatMap((r) => r.tags)
        .map((t) => [t.toLowerCase(), t]),
    ).values(),
  ].sort((a, b) => a.localeCompare(b));
}
function libraryMarkup() {
  return (
    "<h2>Saved recipes</h2>" +
    recipeSearchMarkup({
      placeholder: "Search for a dish, or paste a link",
    }) +
    '<div id="library-results" aria-live="polite">' +
    libraryCards("") +
    "</div>"
  );
}
function libraryCards(query) {
  const recipes = matchSavedRecipes(savedRecipes, query);
  const looking = query.trim();
  const empty = !recipes.length
    ? '<div class="empty"><h3>' +
      (looking
        ? "No recipes match this search."
        : "Your recipes, all in one place.") +
      "</h3><p>" +
      (looking
        ? "Try another search, paste a link, or create a recipe."
        : "Create a recipe to start your collection.") +
      "</p></div>"
    : "";
  return (
    empty +
    '<div class="project-grid saved-recipe-grid">' +
    recipes
      .map((r) => {
        const minutes = Number(
          r.steps.reduce((sum, step) => sum + Number(step.minutes), 0).toFixed(2),
        );
        return (
          '<a class="project-card" href="/recipe/edit/' +
          r.id +
          '"><span class="recipe-card-meta">Serves ' +
          esc(r.servings) +
          ", " +
          (r.steps.some(s => s.minutes == null || String(s.minutes).trim() === "") ? "Needs timing review · " : minutes + " min across ") +
          r.steps.length +
          " steps</span><h3>" +
          esc(r.title) +
          '</h3><div class="tags recipe-card-tags" title="' +
          esc(r.tags.join(", ")) +
          '">' +
          r.tags.map((t) => '<span class="tag">' + esc(t) + "</span>").join("") +
          "</div></a>"
        );
      })
      .join("") +
    '<button type="button" class="project-card new-recipe-card" id="new-recipe-card"><span aria-hidden="true">＋</span><span>New recipe</span></button></div>'
  );
}
function bindLibrarySearch() {
  recipeBindings.push(bindRecipeSearch({
    input: document.querySelector("#recipe-search"),
    listbox: document.querySelector("#recipe-search-list"),
    status: document.querySelector("#recipe-search-status"),
    getSaved: () => savedRecipes,
    onQuery: (query) => {
      document.querySelector("#library-results").innerHTML = libraryCards(query);
    },
    onSelectSaved: (recipe) => navigate("/recipe/edit/" + recipe.id),
    onSelectOnline: (result) => openImportedRecipe(result),
  }));
}
function openImportedRecipe(result, context) {
  startRecipe({
    ...context,
    title: result.title || context?.title || "",
    importPendingUrl: result.url,
    importPendingRecipeId: result.recipeId,
    importNotice: "Importing…",
  });
}
function startRecipe(context) {
  const id = crypto.randomUUID();
  recipeDrafts[id] = {
    id,
    title: context?.title || "",
    servings: 4,
    tags: [],
    ingredients: [""],
    steps: [{ text: "", minutes: "" }],
    ...(context?.importPendingUrl
      ? {
          importPendingUrl: context.importPendingUrl,
          sourceUrl: context.importPendingUrl,
        }
      : {}),
    ...(context?.importNotice ? { importNotice: context.importNotice } : {}),
    ...(context?.importPendingRecipeId ? { importPendingRecipeId: context.importPendingRecipeId } : {}),
    returnTo:
      context?.projectId && context?.dishId
        ? { projectId: context.projectId, dishId: context.dishId }
        : null,
  };
  save();
  navigate("/recipe/new/" + id);
}
function showRecipeEditor(id) {
  disposeRecipeBindings();
  if (!recipeDrafts[id] && savedRecipes[id])
    recipeDrafts[id] = JSON.parse(JSON.stringify(savedRecipes[id]));
  const d = recipeDrafts[id];
  if (!d) {
    app.innerHTML =
      '<main class="home"><h1>Recipe not found.</h1><a href="/recipes">Saved recipes</a></main>';
    return;
  }
  d.ingredientQuantities = d.ingredients.map(
    (name, i) => d.ingredientQuantities?.[i] || "",
  );
  const back =
    d.returnTo && projects[d.returnTo.projectId]
      ? "/project/" + d.returnTo.projectId
      : "/recipes";
  app.innerHTML = `<header class="topbar"><a class="brand" href="/">Mise Studio<span class="period">.</span></a><span id="save-status" role="status">Recipe draft</span></header><main class="workspace recipe-editor"><a class="back" href="${back}">← ${d.returnTo ? "Back to project" : "Saved recipes"}</a><div class="page-heading recipe-title-row"><div><div class="eyebrow">YOUR RECIPE</div><h1>${savedRecipes[id] ? "Edit recipe" : "Create a recipe"}<span class="period">.</span></h1></div><button class="primary save-button" type="submit" form="recipe-form">Save recipe</button></div>${recipeSource(d)}<form id="recipe-form"><p id="recipe-error" role="alert"></p><section class="recipe-section recipe-import" aria-label="Import a recipe"><h2>Find a recipe</h2><p>Search for a dish, paste a link, or paste labelled recipe text. Review ingredients, steps, and times before saving. Unknown times stay blank.</p>${recipeSearchMarkup({ id: "import-search", listId: "import-search-list", statusId: "import-search-status", placeholder: "e.g. cucumber salad, or paste https://" })}<input id="import-url" type="url" hidden maxlength="4096" autocomplete="off"><button type="button" id="import-from-url" hidden>Import URL</button><label class="grow">Or paste a recipe<textarea id="import-text" rows="6" maxlength="100000" placeholder="Title&#10;&#10;Ingredients&#10;- 1 item&#10;&#10;Instructions&#10;1. Cook."></textarea></label><button type="button" class="secondary" id="import-from-text">Import pasted text</button><p id="import-status" class="recipe-import-status" role="status">${d.importNotice ? esc(d.importNotice) : ""}</p><div id="import-choices" class="import-choices"></div></section><section class="parameters"><label class="name-field">Recipe name<input id="recipe-title" maxlength="160" required value="${esc(d.title)}" placeholder="e.g. Japanese potato salad"></label><label>Serves<input id="recipe-servings" type="number" min="1" max="999" step="1" value="${esc(d.servings ?? "")}"></label></section><section class="recipe-section"><h2>Tags</h2><div class="tags">${d.tags.map((t, i) => `<button type="button" class="tag" id="tag-${i}" aria-label="Remove tag ${esc(t)}">${esc(t)} ×</button>`).join("")}</div><div class="entry-row"><label class="grow">Add your own tags<input id="tag-input" maxlength="60" placeholder="e.g. Weeknight, Vegetarian" autocomplete="off" aria-controls="tag-suggestions"></label><button type="button" class="secondary" id="add-tag">Add tag</button></div><div id="tag-suggestions" class="tag-suggestions" aria-label="Matching existing tags"></div></section><section class="recipe-section"><div class="section-heading"><h2>Ingredients</h2></div><p>Enter one ingredient per line. Quantities are optional.</p>${d.ingredients.map((name, i) => `<div class="entry-row ingredient-input-row"><label class="grow">Ingredient ${i + 1}<input id="ingredient-${i}" maxlength="300" value="${esc(name)}" placeholder="e.g. Tomatoes"></label><label class="quantity-field">Quantity<input id="quantity-${i}" maxlength="100" value="${esc(d.ingredientQuantities[i] || "")}" placeholder="e.g. 2 tbsp" aria-label="Quantity for ingredient ${i + 1}"></label><button type="button" class="icon-button" id="remove-ingredient-${i}" aria-label="Remove ingredient ${i + 1}">×</button></div>`).join("")}<button type="button" class="secondary" id="add-ingredient">＋ Add ingredient</button></section><section class="recipe-section"><h2>Steps</h2><p>Drag the handles to rearrange steps.</p><div id="step-order-status" class="sr-only" role="status"></div>${d.steps.map((s, i) => `<div class="step-row" id="step-row-${i}"><button type="button" class="step-grip" id="step-grip-${i}" aria-label="Reorder step ${i + 1}" title="Drag to reorder; Alt + arrow keys to move" ${d.steps.length < 2 ? "disabled" : ""}>⠿</button><label class="grow">Step ${i + 1}<textarea id="step-${i}" rows="3" maxlength="4000" placeholder="Describe this step">${esc(s.text)}</textarea></label><label class="duration-field">Duration (minutes)<input id="minutes-${i}" type="number" min="0" step="any" value="${esc(s.minutes ?? "")}" placeholder="10"></label><button type="button" class="icon-button" id="remove-step-${i}" aria-label="Remove step ${i + 1}">×</button></div>`).join("")}<button type="button" class="secondary" id="add-step">＋ Add step</button></section></form></main>`;
  const field = (selector, fn) =>
    (document.querySelector(selector).oninput = (e) => {
      fn(e.target.value);
      save();
    });
  field("#recipe-title", (v) => (d.title = v));
  field("#recipe-servings", (v) => (d.servings = v));
  const redraw = (focus) => {
    save();
    showRecipeEditor(id);
    if (focus) document.querySelector(focus)?.focus();
  };
  const importer = bindRecipeImport(d, redraw);
  recipeBindings.push(importer);
  recipeBindings.push(bindRecipeSearch({
    input: document.querySelector("#import-search"),
    listbox: document.querySelector("#import-search-list"),
    status: document.querySelector("#import-search-status"),
    includeSaved: false,
    onSelectOnline: (result) => importer?.run(result.recipeId ? { recipeId: result.recipeId } : { url: result.url }),
  }));
  if ((d.importPendingUrl || d.importPendingRecipeId) && importer) {
    const url = d.importPendingUrl;
    const recipeId = d.importPendingRecipeId;
    delete d.importPendingUrl;
    delete d.importPendingRecipeId;
    save();
    importer.run(recipeId ? { recipeId } : { url });
  }
  const addTags = () => {
    const input = document.querySelector("#tag-input");
    input.value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((t) => {
        if (!d.tags.some((x) => x.toLowerCase() === t.toLowerCase()))
          d.tags.push(t);
      });
  };
  document.querySelector("#add-tag").onclick = () => {
    addTags();
    redraw("#tag-input");
  };
  const tagInput = document.querySelector("#tag-input");
  const suggest = () => {
    const q = tagInput.value.trim().toLowerCase();
    const matches = knownTags()
      .filter(
        (t) =>
          t.toLowerCase().includes(q) &&
          !d.tags.some((x) => x.toLowerCase() === t.toLowerCase()),
      )
      .slice(0, 8);
    document.querySelector("#tag-suggestions").innerHTML = matches
      .map(
        (t, i) =>
          '<button type="button" class="tag" id="suggest-tag-' +
          i +
          '">' +
          esc(t) +
          "</button>",
      )
      .join("");
    matches.forEach((t, i) => {
      document.querySelector("#suggest-tag-" + i).onclick = () => {
        d.tags.push(t);
        redraw("#tag-input");
      };
    });
    return matches;
  };
  tagInput.oninput = suggest;
  tagInput.onfocus = suggest;
  tagInput.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (suggest().length) document.querySelector("#suggest-tag-0").focus();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      tagInput.value = "";
      document.querySelector("#tag-suggestions").innerHTML = "";
    }
    if (e.key === "Enter") {
      e.preventDefault();
      addTags();
      redraw("#tag-input");
    }
  };
  suggest();
  d.tags.forEach(
    (t, i) =>
      (document.querySelector("#tag-" + i).onclick = () => {
        d.tags.splice(i, 1);
        redraw("#tag-input");
      }),
  );
  d.ingredients.forEach((v, i) => {
    let original = v,
      originalQuantity = d.ingredientQuantities[i] || "";
    const nameInput = document.querySelector("#ingredient-" + i),
      quantityInput = document.querySelector("#quantity-" + i);
    nameInput.onfocus = () => {
      original = d.ingredients[i];
    };
    quantityInput.onfocus = () => {
      originalQuantity = d.ingredientQuantities[i] || "";
    };
    field("#ingredient-" + i, (v) => (d.ingredients[i] = v));
    field("#quantity-" + i, (v) => (d.ingredientQuantities[i] = v));
    const addNext = (e) => {
      if (e.key === "Enter" && !e.isComposing && !e.repeat) {
        e.preventDefault();
        d.ingredients.splice(i + 1, 0, "");
        d.ingredientQuantities.splice(i + 1, 0, "");
        redraw("#ingredient-" + (i + 1));
      }
    };
    nameInput.onkeydown = (e) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        if (!original.trim()) {
          d.ingredients.splice(i, 1);
          d.ingredientQuantities.splice(i, 1);
        } else d.ingredients[i] = original;
        redraw("#add-ingredient");
        return;
      }
      addNext(e);
    };
    quantityInput.onkeydown = (e) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        d.ingredientQuantities[i] = originalQuantity;
        redraw("#ingredient-" + i);
        return;
      }
      addNext(e);
    };
    document.querySelector("#remove-ingredient-" + i).onclick = () => {
      d.ingredients.splice(i, 1);
      d.ingredientQuantities.splice(i, 1);
      redraw("#add-ingredient");
    };
  });
  document.querySelector("#add-ingredient").onclick = () => {
    d.ingredients.push("");
    d.ingredientQuantities.push("");
    redraw("#ingredient-" + (d.ingredients.length - 1));
  };
  d.steps.forEach((s, i) => {
    field("#step-" + i, (v) => (s.text = v));
    field("#minutes-" + i, (v) => { s.minutes = v; s.durationSource = v.trim() === "" ? "unknown" : "user"; });
    document.querySelector("#remove-step-" + i).onclick = () => {
      d.steps.splice(i, 1);
      redraw("#add-step");
    };
  });
  d.steps.forEach((step, i) => {
    const grip = document.querySelector("#step-grip-" + i);
    const move = (target) => {
      if (target === i || target < 0 || target >= d.steps.length) return;
      const [moved] = d.steps.splice(i, 1);
      d.steps.splice(target, 0, moved);
      redraw("#step-grip-" + target);
      document.querySelector("#step-order-status").textContent =
        "Step " + (i + 1) + " moved to position " + (target + 1) + ".";
    };
    grip.onkeydown = (e) => {
      if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        move(i + (e.key === "ArrowDown" ? 1 : -1));
      }
    };
    grip.onpointerdown = (e) => {
      if (e.button !== 0 || d.steps.length < 2) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const rows = d.steps.map((s, j) =>
          document.querySelector("#step-row-" + j),
        ),
        row = rows[i],
        remaining = rows.filter((r) => r !== row);
      let target = i;
      row.classList.add("step-dragging");
      grip.onpointermove = (event) => {
        target = remaining.filter((r) => {
          const rect = r.getBoundingClientRect();
          return event.clientY > rect.top + rect.height / 2;
        }).length;
        rows.forEach((r) =>
          r.classList.remove("step-drop-before", "step-drop-after"),
        );
        if (target < remaining.length)
          remaining[target].classList.add("step-drop-before");
        else remaining.at(-1).classList.add("step-drop-after");
        if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 14);
        else if (event.clientY < 80) window.scrollBy(0, -14);
      };
      const finish = (event) => {
        grip.onpointermove = null;
        grip.onpointerup = null;
        grip.onpointercancel = null;
        rows.forEach((r) =>
          r.classList.remove(
            "step-dragging",
            "step-drop-before",
            "step-drop-after",
          ),
        );
        if (grip.hasPointerCapture(e.pointerId))
          grip.releasePointerCapture(e.pointerId);
        if (event.type !== "pointercancel") move(target);
      };
      grip.onpointerup = finish;
      grip.onpointercancel = finish;
    };
  });
  document.querySelector("#add-step").onclick = () => {
    d.steps.push({ text: "", minutes: "" });
    redraw("#step-" + (d.steps.length - 1));
  };
  document.querySelector("#recipe-form").onsubmit = (e) => {
    e.preventDefault();
    addTags();
    commitRecipe(id);
  };
}
function commitRecipe(id) {
  const d = recipeDrafts[id],
    ingredients = d.ingredients.map((x) => x.trim()).filter(Boolean);
  const error = !d.title.trim()
    ? "Give your recipe a name."
    : d.servings != null && String(d.servings).trim() !== "" &&
        (!Number.isInteger(Number(d.servings)) || Number(d.servings) < 1 || Number(d.servings) > 999)
      ? "Enter a serving count between 1 and 999."
      : !ingredients.length
        ? "Add at least one ingredient."
        : !d.steps.length ||
            d.steps.some(
              (s) =>
                !s.text.trim() ||
                (s.minutes != null && String(s.minutes).trim() !== "" &&
                  (!Number.isFinite(Number(s.minutes)) || Number(s.minutes) < 0)),
            )
          ? "Add instructions for every step. Durations, when supplied, must be zero or more minutes."
          : "";
  if (error) {
    document.querySelector("#recipe-error").textContent = error;
    return false;
  }
  const before = snapshot();
  savedRecipes[id] = {
    id,
    ...(d.sourceUrl ? { sourceUrl: d.sourceUrl } : {}),
    ...Object.fromEntries(["importMetadata", "ingredientMetadata"].filter(key => d[key] !== undefined).map(key => [key, JSON.parse(JSON.stringify(d[key]))])),
    title: d.title.trim(),
    servings: d.servings == null || String(d.servings).trim() === "" ? null : Number(d.servings),
    tags: [...d.tags],
    ingredients,
    ingredientQuantities: d.ingredients
      .map((name, i) => ({
        name: name.trim(),
        quantity: (d.ingredientQuantities?.[i] || "").trim(),
      }))
      .filter((x) => x.name)
      .map((x) => x.quantity),
    steps: d.steps.map((s) => ({
      ...s,
      text: s.text.trim(),
      minutes: s.minutes == null || String(s.minutes).trim() === "" ? null : Number(s.minutes),
    })),
    updatedAt: new Date().toISOString(),
  };
  const target = projects[d.returnTo?.projectId];
  const dish = target?.courses
    .flatMap((c) => c.dishes)
    .find((x) => x.id === d.returnTo.dishId);
  if (dish) {
    dish.recipe = { provider: "custom", id };
    delete dish.recipeSkipped;
    target.activeTab = "recipes";
    target.recipeDishId = dish.id;
  }
  delete recipeDrafts[id];
  save();
  if (storageFailed) {
    const old = JSON.parse(before);
    projects = Object.assign(Object.create(null), old.projects);
    savedRecipes = Object.assign(Object.create(null), old.recipes);
    recipeDrafts = Object.assign(Object.create(null), old.drafts);
    showRecipeEditor(id);
    document.querySelector("#recipe-error").textContent =
      "Unable to save this recipe. Keep this page open and try again.";
    return false;
  }
  navigate(target ? "/project/" + target.id : "/recipes");
  return true;
}
function attachedRecipe(dish) {
  return dish.recipe?.provider === "custom"
    ? savedRecipes[dish.recipe.id]
    : null;
}
function nextRecipeDish() {
  const dishes = allDishes();
  const i = dishes.findIndex((x) => x.dish.id === project.recipeDishId);
  project.recipeDishId =
    dishes
      .slice(i + 1)
      .find((x) => !attachedRecipe(x.dish) && !x.dish.recipeSkipped)?.dish.id ||
    dishes.find((x) => !attachedRecipe(x.dish) && !x.dish.recipeSkipped)?.dish
      .id ||
    null;
  save();
  drawRecipes();
}
function chooseRecipe(dishId, recipeId) {
  const dish = allDishes().find((x) => x.dish.id === dishId)?.dish;
  if (!dish || !savedRecipes[recipeId]) return;
  dish.recipe = { provider: "custom", id: recipeId };
  delete dish.recipeSkipped;
  project.recipeDishId = dishId;
  save();
  drawRecipes();
}
function drawRecipes() {
  disposeRecipeBindings();
  const dishes = allDishes(),
    panel = document.querySelector("#recipes-panel");
  if (!dishes.length) {
    panel.innerHTML =
      '<div class="empty"><h3>Plan your dishes first.</h3><p>Add dishes in the Planner tab, then attach your saved recipes here.</p></div>';
    return;
  }
  let current = dishes.find((x) => x.dish.id === project.recipeDishId);
  if (project.recipeDishId === undefined)
    current = dishes.find(
      (x) => !attachedRecipe(x.dish) && !x.dish.recipeSkipped,
    );
  panel.innerHTML = `<div class="recipe-heading"><div><div class="eyebrow">YOUR RECIPES</div><h2>${current ? esc(current.dish.name || "Untitled dish") : "Recipe selections"}</h2><p>${dishes.filter((x) => attachedRecipe(x.dish)).length} of ${dishes.length} dishes have recipes</p></div></div><div class="dish-navigation">${dishes.map((x, i) => `<button class="secondary" id="select-dish-${i}" ${current === x ? 'aria-current="step"' : ""}>${esc(x.dish.name || "Untitled dish")} ${attachedRecipe(x.dish) ? "✓" : x.dish.recipeSkipped ? "· Skipped" : ""}</button>`).join("")}</div>${
    current
      ? `<p class="eyebrow">${esc(current.courseName)}</p>${attachedRecipe(current.dish) ? `<p class="selected-notice">Attached: <strong>${esc(attachedRecipe(current.dish).title)}</strong></p>` : current.dish.recipe ? "<p>Choose a saved recipe to replace the previous online recipe.</p>" : ""}${current.dish.recipe ? '<button class="secondary" id="unattach-recipe">Unattach recipe</button>' : ""}${
          attachedRecipe(current.dish)
            ? attachedRecipeMarkup(attachedRecipe(current.dish))
            : `<div class="section-heading"><h3>Find a recipe</h3><button class="primary" id="create-for-dish">＋ Create new recipe</button></div>${recipeSearchMarkup({
                    id: "dish-recipe-search",
                    listId: "dish-recipe-search-list",
                    statusId: "dish-recipe-search-status",
                    value: current.dish.name || "",
                    placeholder: "Search for a dish, or paste a link",
                  })}${
                Object.values(savedRecipes).length
                  ? `<div class="project-grid">${Object.values(savedRecipes)
                      .map(
                        (r, i) =>
                          `<article class="custom-recipe-card"><h3>${esc(r.title)}</h3><p>${recipeMeta(r)}</p><div class="tags">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div><details><summary>View recipe</summary><ul>${r.ingredients.map((x, i) => `<li>${esc([r.ingredientQuantities?.[i], x].filter(Boolean).join(" "))}</li>`).join("")}</ul><ol>${r.steps.map((s) => `<li>${esc(s.text)} <small>(${s.minutes == null ? "Needs timing review" : `${s.minutes} min`})</small></li>`).join("")}</ol></details><button class="secondary" id="attach-${i}">Attach recipe</button></article>`,
                      )
                      .join("")}</div>`
                  : '<div class="empty"><p>No saved recipes yet. Create one for this dish.</p></div>'
              }`
        }<div class="finalize-row"><button class="secondary" id="skip-recipe">${attachedRecipe(current.dish) ? "Next dish →" : "Skip for now →"}</button></div>`
      : '<div class="empty"><h3>Your selections are ready.</h3><p>You can revisit any dish above, or continue to your ingredients.</p></div>'
  }`;
  dishes.forEach(
    (x, i) =>
      (document.querySelector("#select-dish-" + i).onclick = () => {
        project.recipeDishId = x.dish.id;
        save();
        drawRecipes();
      }),
  );
  if (current) {
    project.recipeDishId = current.dish.id;
    if (current.dish.recipe)
      document.querySelector("#unattach-recipe").onclick = () => {
        delete current.dish.recipe;
        delete current.dish.recipeSkipped;
        save();
        drawRecipes();
      };
    if (!attachedRecipe(current.dish)) {
      document.querySelector("#create-for-dish").onclick = () =>
        startRecipe({
          projectId: project.id,
          dishId: current.dish.id,
          title: current.dish.name,
        });
      recipeBindings.push(bindRecipeSearch({
        input: document.querySelector("#dish-recipe-search"),
        listbox: document.querySelector("#dish-recipe-search-list"),
        status: document.querySelector("#dish-recipe-search-status"),
        getSaved: () => savedRecipes,
        onSelectSaved: (recipe) => chooseRecipe(current.dish.id, recipe.id),
        onSelectOnline: (result) =>
          openImportedRecipe(result, {
            projectId: project.id,
            dishId: current.dish.id,
            title: current.dish.name,
          }),
      }));
      Object.values(savedRecipes).forEach(
        (r, i) =>
          (document.querySelector("#attach-" + i).onclick = () =>
            chooseRecipe(current.dish.id, r.id)),
      );
    }
    document.querySelector("#skip-recipe").onclick = () => {
      if (!attachedRecipe(current.dish)) current.dish.recipeSkipped = true;
      nextRecipeDish();
    };
  }
}
function drawIngredients() {
  const dishes = allDishes(),
    selected = dishes.filter((x) => attachedRecipe(x.dish));
  const unique = new Map(),
    nameCounts = new Map();
  for (const { dish } of dishes) {
    const name = dish.name.trim().toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  for (const { dish, courseName } of selected) {
    const recipe = attachedRecipe(dish);
    for (const name of recipe.ingredients) {
      const fullName = name.trim(),
        key = fullName.toLowerCase().replace(/\s+/g, " ");
      if (!key) continue;
      if (!unique.has(key))
        unique.set(key, { name: fullName, uses: new Map() });
      const duplicateName = nameCounts.get(dish.name.trim().toLowerCase()) > 1;
      unique.get(key).uses.set(dish.id, {
        dishId: dish.id,
        label:
          (dish.name.trim() || recipe.title) +
          (duplicateName ? " · " + courseName : ""),
        recipeTitle: recipe.title,
      });
    }
  }
  const edits = (project.ingredientEdits ||= { omitted: [], groups: [] });
  const omitted = new Set(edits.omitted),
    grouped = new Set();
  const ingredients = [];
  function makeRow(id, keys, groupId) {
    const parts = keys.map((key) => unique.get(key));
    return {
      id,
      keys,
      groupId,
      name: parts.map((p) => p.name).join(", "),
      uses: new Map(parts.flatMap((p) => [...p.uses])),
      omitted: keys.every((k) => omitted.has(k)),
    };
  }
  for (const group of edits.groups) {
    const keys = group.keys.filter((k) => unique.has(k) && !grouped.has(k));
    keys.forEach((k) => grouped.add(k));
    if (keys.length) ingredients.push(makeRow(group.id, keys, group.id));
  }
  for (const key of unique.keys())
    if (!grouped.has(key)) ingredients.push(makeRow(key, [key], null));
  ingredients.sort((a, b) => a.name.localeCompare(b.name));
  document.querySelector("#ingredients-panel").innerHTML =
    `<div class="recipe-heading"><div><div class="eyebrow">YOUR SHOPPING LIST</div><h2>Ingredients</h2><p>${ingredients.length} ingredients from ${selected.length} selected ${selected.length === 1 ? "recipe" : "recipes"}. ${dishes.length - selected.length} dishes without a saved recipe omitted.</p></div></div>${ingredients.length ? `<p class="ingredient-guide">Select entries to adjust this project’s list. Dish labels open the associated recipe.</p><div class="ingredient-toolbar" role="group" aria-label="Ingredient actions"><label><input type="checkbox" id="ingredients-select-all"> Select all</label><span id="ingredient-selection-count" role="status">0 selected</span><button class="secondary" id="ingredients-omit" disabled>Omit</button><button class="secondary" id="ingredients-combine" disabled>Combine</button></div><ul class="ingredient-list">${ingredients.map((x, i) => `<li><input type="checkbox" class="ingredient-checkbox" id="ingredient-select-${i}" aria-label="Select ${esc(x.name)}"><label class="ingredient-entry${x.omitted ? " ingredient-omitted" : ""}" for="ingredient-select-${i}"><span class="ingredient-name">${esc(x.name)}</span>${x.omitted ? '<small class="ingredient-state">Omitted</small>' : ""}${x.groupId ? '<small class="ingredient-state">Combined</small>' : ""}</label><div class="ingredient-uses${x.omitted ? " ingredient-omitted" : ""}" aria-label="Used in">${[...x.uses.values()].map((use) => `<button class="ingredient-dish" data-ingredient-dish="${esc(use.dishId)}" title="Recipe: ${esc(use.recipeTitle)}" aria-label="View ${esc(use.label)} recipe: ${esc(use.recipeTitle)}">${esc(use.label)}</button>`).join("")}</div>${x.omitted || x.groupId ? `<div class="ingredient-row-actions">${x.omitted ? `<button class="secondary" id="ingredient-include-${i}" aria-label="Include ${esc(x.name)}">Include</button>` : ""}${x.groupId ? `<button class="secondary" id="ingredient-separate-${i}" aria-label="Separate ${esc(x.name)}">Separate</button>` : ""}</div>` : ""}</li>`).join("")}</ul>` : `<div class="empty"><h3>${selected.length ? "No ingredients on your list." : "Your ingredient list starts with a recipe."}</h3><p>${selected.length ? "Add ingredients to an attached recipe." : "Attach a saved recipe in the Recipes tab."}</p></div>`}<div class="finalize-row"><button class="primary" id="continue-timeline">Continue →</button></div>`;
  document.querySelector("#continue-timeline").onclick = () => {
    setTab("timeline");
    document.querySelector("#timeline-tab").focus();
  };
  const checked = new Set();
  const selection = () => ingredients.filter((x, i) => checked.has(i));
  const updateSelection = () => {
    const rows = selection(),
      all = document.querySelector("#ingredients-select-all");
    all.checked = rows.length === ingredients.length;
    all.indeterminate = rows.length > 0 && rows.length < ingredients.length;
    document.querySelector("#ingredient-selection-count").textContent =
      rows.length + " selected";
    for (const action of ["omit"])
      document.querySelector("#ingredients-" + action).disabled = !rows.length;
    document.querySelector("#ingredients-combine").disabled = rows.length < 2;
  };
  ingredients.forEach((row, i) => {
    document.querySelector("#ingredient-select-" + i).onchange = (e) => {
      if (e.target.checked) checked.add(i);
      else checked.delete(i);
      updateSelection();
    };
  });
  const apply = (action, rows = selection()) => {
    const keys = rows.flatMap((r) => r.keys);
    if (!rows.length) return;
    if (action === "omit")
      edits.omitted = [...new Set([...edits.omitted, ...keys])];
    if (action === "include")
      edits.omitted = edits.omitted.filter((k) => !keys.includes(k));
    if (action === "separate" || action === "combine") {
      if (action === "combine" && rows.length < 2) return;
      const groupIds = rows.map((r) => r.groupId).filter(Boolean);
      // Preserve original members even when their recipe is temporarily unattached.
      const originalKeys = [
        ...new Set(
          rows.flatMap((r) =>
            r.groupId
              ? edits.groups.find((g) => g.id === r.groupId).keys
              : r.keys,
          ),
        ),
      ];
      edits.groups = edits.groups.filter((g) => !groupIds.includes(g.id));
      if (action === "combine")
        edits.groups.push({ id: crypto.randomUUID(), keys: originalKeys });
    }
    save();
    drawIngredients();
  };
  if (ingredients.length) {
    document.querySelector("#ingredients-select-all").onchange = (e) => {
      ingredients.forEach((r, i) => {
        document.querySelector("#ingredient-select-" + i).checked =
          e.target.checked;
        if (e.target.checked) checked.add(i);
        else checked.delete(i);
      });
      updateSelection();
    };
    for (const action of ["omit", "combine"])
      document.querySelector("#ingredients-" + action).onclick = () =>
        apply(action);
  }
  ingredients.forEach((row, i) => {
    if (row.omitted)
      document.querySelector("#ingredient-include-" + i).onclick = () =>
        apply("include", [row]);
    if (row.groupId)
      document.querySelector("#ingredient-separate-" + i).onclick = () =>
        apply("separate", [row]);
  });
  document.querySelectorAll("[data-ingredient-dish]").forEach((button) => {
    button.onclick = () => {
      project.recipeDishId = button.dataset.ingredientDish;
      setTab("recipes");
      document.querySelector("#recipes-tab").focus();
    };
  });
}

function attachedRecipeMarkup(recipe) {
  return `<article class="custom-recipe-card attached-recipe" aria-label="Attached recipe"><p>${recipeMeta(recipe)}</p>${recipeSource(recipe)}<div class="tags">${recipe.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div><h3>Ingredients</h3><ul>${recipe.ingredients.map((name, i) => `<li>${esc([recipe.ingredientQuantities?.[i], name].filter(Boolean).join(" "))}</li>`).join("")}</ul><h3>Steps</h3><ol>${recipe.steps.map((step) => `<li>${esc(step.text)} <small>(${step.minutes == null ? "Needs timing review" : `${step.minutes} min`})</small></li>`).join("")}</ol></article>`;
}

function shiftTimeline(dishId, index, delta) {
  const model = timelineModel(project, savedRecipes),
    dish = model.dishes.find((d) => d.id === dishId);
  if (
    !dish?.blocks.length ||
    !Number.isFinite(delta) ||
    index < 0 ||
    index >= dish.blocks.length
  )
    return;
  const state = (project.timeline ||= {});
  state.offsets ||= {};
  let entry = state.offsets[dishId];
  if (entry?.signature !== dish.signature)
    entry = { signature: dish.signature, values: dish.blocks.map(() => 0) };
  entry.values = dish.blocks.map(
    (b, i) => (Number(entry.values[i]) || 0) + (i >= index ? delta : 0),
  );
  state.offsets[dishId] = entry;
  save();
}
function drawTimeline(scrollPosition, verticalPosition) {
  const state = (project.timeline ||= {
    zoom: 4,
    offsets: {},
    plannerOpen: false,
  });
  const model = timelineModel(project, savedRecipes),
    zoom = Math.min(16, Math.max(0.5, Number(state.zoom) || 4));
  const visible = model.dishes,
    blocks = visible.flatMap((d) => d.blocks),
    services = model.services;
  const width = Math.max(800, (model.max - model.min) * zoom),
    header = 48 + services.length * 24;
  let rowTop = header;
  const layout = [], rows = [];
  for (const dish of model.dishes) {
    const ends = [];
    for (const block of [...dish.blocks].sort((a,b)=>a.start-b.start||a.index-b.index)) {
      const start=(block.start-model.min)*zoom, blockWidth=Math.max(10,block.duration*zoom-2);
      let lane=ends.findIndex(end=>end<=start);if(lane<0)lane=ends.length;
      ends[lane]=start+blockWidth+2;
      layout.push({...block,left:start,width:blockWidth,top:rowTop+lane*50+7});
    }
    const rowHeight=Math.max(1,ends.length)*50;
    rows.push({...dish,top:rowTop,height:rowHeight});rowTop+=rowHeight;
  }
  const height = Math.max(300, rowTop + 30),
    baseInterval = zoom >= 10 ? 5 : zoom >= 4 ? 15 : zoom >= 2 ? 30 : 60,
    interval =
      baseInterval *
      Math.max(1, Math.ceil((model.max - model.min) / baseInterval / 500)),
    ticks = [];
  for (
    let tick = 0, time = Math.ceil(model.min / interval) * interval;
    tick <= 500 && time <= model.max;
    tick++, time += interval
  )
    ticks.push(time);
  const list = [...blocks].sort(
    (a, b) =>
      a.start - b.start ||
      a.dishName.localeCompare(b.dishName) ||
      a.index - b.index,
  );
  const panel = document.querySelector("#timeline-panel");
  panel.innerHTML = `<div class="tl-heading"><div><div class="eyebrow">THE COOKING PLAN</div><h2>Timeline</h2><p>Steps finish at their course’s service time. Drag a step to move it and its following steps.</p></div><div class="tl-controls"><label>Zoom<input id="tl-zoom" type="range" min="0.5" max="16" step="0.5" value="${zoom}" aria-label="Timeline zoom"></label><button class="secondary" id="tl-reset">Reset timeline</button><button class="primary" id="tl-planner-toggle" aria-expanded="${Boolean(state.plannerOpen)}" aria-controls="tl-planner">Cooking planner</button></div></div><div class="tl-legend" aria-label="Dish legend">${visible
    .filter((d) => d.blocks.length)
    .map(
      (d) => `<span><i style="background:${d.color}"></i>${esc(d.name)}</span>`,
    )
    .join(
      "",
    )}</div>${model.issues.length ? `<details class="tl-issues"><summary>${model.issues.length} ${model.issues.length === 1 ? "dish needs" : "dishes need"} attention before scheduling</summary><ul>${model.issues.map((i) => `<li><strong>${esc(i.name)}:</strong> ${esc(i.reason)}</li>`).join("")}</ul></details>` : ""}<div class="tl-workspace"><div class="tl-chart-area"><div class="tl-scroll" id="tl-scroll" tabindex="0" aria-label="Scrollable cooking timeline"><div class="tl-chart-track"><div class="tl-row-axis" aria-label="Dish rows" style="height:${height}px"><div class="tl-axis-heading" style="height:${header}px"><strong>Dishes</strong></div>${rows.map((row,i)=>`<div class="tl-axis-row" style="top:${row.top}px;height:${row.height}px" title="${esc(row.name)} · ${esc(row.courseName)}"><i style="background:${row.color}"></i><span><strong>${esc(row.name)}</strong><small>${esc(row.courseName)}${!row.blocks.length?' · Not scheduled':''}</small></span></div>`).join('')}</div><div class="tl-canvas" style="width:${width}px;height:${height}px">${rows.map(row=>`<div class="tl-row-band" style="top:${row.top}px;height:${row.height}px" aria-hidden="true"></div>`).join('')}${ticks.map((t) => `<div class="tl-tick" style="left:${(t - model.min) * zoom}px;height:${height}px"><span>${timelineTime(t)}</span></div>`).join("")}${services.map((s, i) => `<div class="tl-service" style="left:${(s.time - model.min) * zoom}px;top:${34 + i * 24}px;height:${height - 34 - i * 24}px"><span>${esc(s.name)} · ${timelineTime(s.time)}</span></div>`).join("")}${layout.map((b, i) => `<button type="button" class="tl-block" id="tl-block-${i}" data-tl-dish="${esc(b.dishId)}" data-tl-step="${b.index}" style="left:${b.left}px;top:${b.top}px;width:${b.width}px;background:${b.color}" aria-label="${esc(b.dishName)}, step ${b.index + 1}: ${esc(b.text)}, ${b.duration} minutes, ${timelineTime(b.start)}" title="${esc(b.dishName)} · Step ${b.index + 1}&#10;${esc(b.text)}&#10;${b.duration} min · ${timelineTime(b.start)}–${timelineTime(b.end)}">${esc(b.text.trim().split(/\s+/)[0] || "Step")}</button>`).join("")}${!blocks.length ? '<div class="tl-empty">No steps are scheduled yet. Complete the items needing attention to build the timeline.</div>' : ""}</div></div></div><p class="tl-hint">Scroll sideways to explore. Hover or focus a block for details. Dragging snaps to five-minute marks. Arrow keys move a focused step to the next five-minute mark. Times after midnight show a day offset.</p><p id="tl-status" role="status" class="sr-only"></p></div></div><aside id="tl-planner" class="tl-planner" aria-label="Cooking planner" ${state.plannerOpen ? "" : "hidden"}><div class="tl-planner-heading"><h3>Cooking planner</h3><button class="secondary" id="tl-planner-close" aria-label="Close cooking planner">×</button></div><p>Start times for all scheduled dishes</p><ol>${list.map((b) => `<li><time>${timelineTime(b.start)}</time><div><strong style="color:${b.color}">${esc(b.dishName)} · Step ${b.index + 1}</strong><p>${esc(b.text)}</p><small>${b.duration} min</small></div></li>`).join("") || "<li>No steps to show.</li>"}</ol></aside><div id="tl-tooltip" class="tl-tooltip" role="tooltip" hidden></div>`;
  const scroller = document.querySelector("#tl-scroll");
  if (Number.isFinite(scrollPosition)) scroller.scrollLeft = scrollPosition;
  if(Number.isFinite(verticalPosition))scroller.scrollTop=verticalPosition;
  const redraw = () => drawTimeline(scroller.scrollLeft || 0, scroller.scrollTop || 0);
  document.querySelector("#tl-zoom").oninput = (e) => {
    const chartViewport = Math.max(1, (scroller.clientWidth || 800) - (document.querySelector(".tl-row-axis").offsetWidth || 210));
    const old = Number(state.zoom) || 4,
      center =
        model.min +
        ((scroller.scrollLeft || 0) + chartViewport / 2) / old;
    state.zoom = Number(e.target.value);
    save();
    drawTimeline(
      Math.max(
        0,
        (center - model.min) * state.zoom - chartViewport / 2,
      ),
      scroller.scrollTop || 0,
    );
  };
  document.querySelector("#tl-reset").onclick = () => {
    state.offsets = {};
    save();
    redraw();
    document.querySelector("#tl-status").textContent =
      "Timeline restored to course service times.";
  };
  const drawer = (open) => {
    state.plannerOpen = open;
    save();
    redraw();
    document
      .querySelector(open ? "#tl-planner-close" : "#tl-planner-toggle")
      .focus();
  };
  document.querySelector("#tl-planner-toggle").onclick = () =>
    drawer(!state.plannerOpen);
  document.querySelector("#tl-planner-close").onclick = () => drawer(false);
  document.querySelector("#tl-planner").onkeydown = (e) => {
    if (e.key === "Escape") drawer(false);
  };
  layout.forEach((b, i) => {
    const el = document.querySelector("#tl-block-" + i),
      tooltip = document.querySelector("#tl-tooltip");
    const hideTooltip = () => {
      tooltip.hidden = true;
    };
    const showTooltip = (x, y) => {
      tooltip.innerHTML =
        "<strong>" +
        esc(b.dishName) +
        " · Step " +
        (b.index + 1) +
        "</strong><p>" +
        esc(b.text) +
        "</p><small>" +
        b.duration +
        " min · " +
        timelineTime(b.start) +
        "–" +
        timelineTime(b.end) +
        "</small>";
      tooltip.hidden = false;
      tooltip.style.left =
        Math.max(8, Math.min(x + 12, (window.innerWidth || 1000) - 340)) + "px";
      tooltip.style.top =
        Math.max(
          8,
          Math.min(
            y + 14,
            (window.innerHeight || 800) - tooltip.offsetHeight - 12,
          ),
        ) + "px";
    };
    el.onmouseenter = (e) => showTooltip(e.clientX, e.clientY);
    el.onmouseleave = hideTooltip;
    el.onblur = hideTooltip;
    el.onfocus = () => {
      const rect = el.getBoundingClientRect();
      showTooltip(rect.left, rect.bottom);
    };
    const moved = (delta) => {
      shiftTimeline(b.dishId, b.index, delta);
      redraw();
      const current = timelineModel(project, savedRecipes).dishes.find(
        (d) => d.id === b.dishId,
      ).blocks[b.index];
      document.querySelector("#tl-status").textContent =
        `${b.dishName}, step ${b.index + 1} now starts at ${timelineTime(current.start)}.`;
    };
    el.onkeydown = (e) => {
      if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        const target = e.key === "ArrowRight" ? (Math.floor(b.start / 5) + 1) * 5 : (Math.ceil(b.start / 5) - 1) * 5;
        moved(target - b.start);
        document
          .querySelector(
            '[data-tl-dish="' + b.dishId + '"][data-tl-step="' + b.index + '"]',
          )
          ?.focus();
      }
    };
    el.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      hideTooltip();
      el.setPointerCapture(e.pointerId);
      el.classList.add("tl-dragging");
      const origin = e.clientX,
        initialScroll = scroller.scrollLeft || 0;
      let delta = 0;
      const affected = layout
        .map((x, j) => ({ x, el: document.querySelector("#tl-block-" + j) }))
        .filter((o) => o.x.dishId === b.dishId && o.x.index >= b.index);
      el.onpointermove = (event) => {
        const rect = scroller.getBoundingClientRect();
        if (event.clientX > rect.right - 40) scroller.scrollLeft += 18;
        else if (event.clientX < rect.left + (document.querySelector(".tl-row-axis").offsetWidth || 210) + 40) scroller.scrollLeft -= 18;
        const rawStart = b.start + (event.clientX - origin + (scroller.scrollLeft || 0) - initialScroll) / zoom;
        delta = Math.round(rawStart / 5) * 5 - b.start;
        affected.forEach(
          (o) => (o.el.style.transform = `translateX(${delta * zoom}px)`),
        );
      };
      const finish = (event) => {
        el.onpointermove = null;
        el.onpointerup = null;
        el.onpointercancel = null;
        el.classList.remove("tl-dragging");
        if (el.hasPointerCapture(e.pointerId))
          el.releasePointerCapture(e.pointerId);
        affected.forEach((o) => (o.el.style.transform = ""));
        if (event.type !== "pointercancel" && delta) moved(delta);
      };
      el.onpointerup = finish;
      el.onpointercancel = finish;
    };
  });
}
