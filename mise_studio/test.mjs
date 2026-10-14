import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { validateWorkspace } from "./public/storage.js";

const source = readFileSync(
  new URL("./public/app.js", import.meta.url),
  "utf8",
);
const saved = new Map();
function session(path = "/", hooks = {}) {
  const nodes = new Map();
  const listeners = {};
  let focused;
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        value: "",
        innerHTML: "",
        textContent: "",
        disabled: false,
        dataset: {},
        setAttribute(k, v) {
          this[k] = v;
        },
        focus() {
          focused = selector;
        },
        classList: { add() {}, remove() {} },
        querySelector(s) {
          return node(selector + " " + s);
        },
        querySelectorAll() {
          return [];
        },
      });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll(selector) {
        if (selector === "[data-course]")
          return [
            ...node("#courses").innerHTML.matchAll(/data-course="([^"]+)"/g),
          ].map((m, i) => {
            const card = node(`[data-course="${m[1]}"]`);
            card.querySelectorAll = (selector) => {
              const html = node("#courses")
                .innerHTML.split('data-course="' + m[1] + '"')[1]
                .split("</article>")[0];
              const attribute =
                selector === "[data-dish]" ? "data-dish" : "data-remove-dish";
              return [
                ...html.matchAll(new RegExp(attribute + '="([^\x22]+)"', "g")),
              ].map((match) => {
                const item = node("[" + attribute + '="' + match[1] + '"]');
                item.dataset =
                  attribute === "data-dish"
                    ? { dish: match[1] }
                    : { removeDish: match[1] };
                return item;
              });
            };
            card.getBoundingClientRect = () => ({
              top: 100 + i * 200,
              height: 180,
            });
            const grip = card.querySelector(".grip");
            grip.setPointerCapture = () => {};
            grip.hasPointerCapture = () => true;
            grip.releasePointerCapture = () => {};
            return card;
          });
        return [];
      },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
    },
    location: { pathname: path },
    history: {
      pushState(_, __, p) {
        context.location.pathname = p;
      },
      replaceState(_, __, p) {
        context.location.pathname = p;
      },
    },
    window: {
      addEventListener() {},
      scrollTo() {},
      scrollBy() {},
      innerHeight: 900,
    },
    localStorage: {
      getItem: (k) => saved.get(k) || null,
      setItem: (k, v) => saved.set(k, v),
    },
    crypto: { randomUUID },
    confirm: () => true,
    console,
    AbortController,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    fetch:
      hooks.fetch ||
      (async (url) => {
        if (String(url).includes("/api/recipe-search")) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: {
                code: "SEARCH_NOT_CONFIGURED",
                message: "Search is not configured on this server.",
              },
            }),
          };
        }
        throw new Error("fetch is not mocked");
      }),
  });
  vm.runInContext(
    "(function(){" +
      readFileSync(
        new URL("./public/storage.js", import.meta.url),
        "utf8",
      ).replaceAll("export function", "function") +
      ";globalThis.loadWorkspace=loadWorkspace;})()",
    context,
  );
  vm.runInContext(
    readFileSync(
      new URL("./public/timeline-model.js", import.meta.url),
      "utf8",
    ).replaceAll("export function", "function"),
    context,
  );
  vm.runInContext(
    "(function(){" +
      readFileSync(
        new URL("./public/recipe-import.js", import.meta.url),
        "utf8",
      )
        .replaceAll("export async function", "async function")
        .replaceAll("export function", "function") +
      ";globalThis.bindRecipeImport=bindRecipeImport;globalThis.bindRecipeSearch=bindRecipeSearch;globalThis.recipeSearchMarkup=recipeSearchMarkup;globalThis.matchSavedRecipes=matchSavedRecipes;globalThis.looksLikeHttpUrl=looksLikeHttpUrl;globalThis.applyImportedRecipe=applyImportedRecipe;globalThis.importedRecipeToDraft=importedRecipeToDraft;globalThis.formatImportNotice=formatImportNotice;})()",
    context,
  );
  vm.runInContext(source.replace(/^import [\s\S]*?;$/gm, ""), context);
  return {
    context,
    node,
    listeners,
    get focused() {
      return focused;
    },
    run: (s) => vm.runInContext(s, context),
  };
}
const s = session();
assert.match(s.node("#app").innerHTML, /Mise Studio/);
s.node("#new-project").onclick();
const path = s.context.location.pathname;
assert.match(path, /^\/project\//);
s.node("#project-name").oninput({ target: { value: "Sunday supper" } });
s.node("#guest-count").oninput({
  target: { value: "8", checkValidity: () => true },
});
s.node("#guest-count").oninput({
  target: { value: "-2", checkValidity: () => false },
});
s.node("#project-date").oninput({
  target: { value: "2026-10-04", checkValidity: () => true },
});
assert.equal(s.run("project.guests"), 8);
s.node("#add-course").onclick();
s.node("#add-course").onclick();
s.node("#add-course").onclick();
const ids = JSON.parse(s.run("JSON.stringify(project.courses.map(c=>c.id))"));
s.node(`[data-course="${ids[0]}"] .course-name`).oninput({
  target: { value: "Starter" },
});
s.node(`[data-course="${ids[0]}"] .course-time`).oninput({
  target: { value: "18:30" },
});
s.node(`[data-course="${ids[0]}"] .add-dish`).onclick();
assert.equal(s.run("project.courses[0].dishes.length"), 1);
const grip = s.node(`[data-course="${ids[0]}"] .grip`);
grip.onpointerdown({ button: 0, pointerId: 1, preventDefault() {} });
grip.onpointermove({ clientY: 700 });
grip.onpointerup({ type: "pointerup" });
assert.equal(s.run("project.courses[2].id"), ids[0]);
assert.equal(s.run("project.courses[2].time"), "18:30");
assert.equal(s.run("project.courses[2].dishes.length"), 1);
assert.equal(s.node(`[data-course="${ids[0]}"] .grip`).onkeydown, undefined);
assert.doesNotMatch(s.node("#courses").innerHTML, /data-action="(?:up|down)"/);
const dishId = s.run("project.courses[2].dishes[0].id");
const dishInput = s.node(`[data-dish="${dishId}"]`);
dishInput.oninput({ target: { value: "Tomato salad" } });
dishInput.onkeydown({ key: "Enter", isComposing: true, preventDefault() {} });
assert.equal(s.run("project.courses[2].dishes.length"), 1);
dishInput.onkeydown({ key: "Enter", preventDefault() {} });
assert.equal(s.run("project.courses[2].dishes.length"), 2);
assert.equal(s.run("project.courses[2].dishes[0].name"), "Tomato salad");
assert.equal(
  s.focused,
  `[data-dish="${s.run("project.courses[2].dishes[1].id")}"]`,
);
s.node("#save-project").onclick();
assert.equal(s.node("#save-status").textContent, "Project saved");
const clickLink = (href) =>
  s.listeners.click({
    target: { closest: () => ({ getAttribute: () => href }) },
    button: 0,
    preventDefault() {},
  });
clickLink("/");
assert.match(s.node("#app").innerHTML, /Sunday supper/);
assert.match(s.node("#app").innerHTML, /8 guests · 3 courses/);
clickLink(path);
assert.equal(s.context.location.pathname, path);
assert.equal(s.run("project.courses[2].dishes[0].name"), "Tomato salad");
const reloaded = session(path);
assert.equal(reloaded.run("project.name"), "Sunday supper");
assert.equal(reloaded.run("project.date"), "2026-10-04");
assert.equal(reloaded.run("project.courses[2].id"), ids[0]);
assert.equal(reloaded.run("project.courses[2].dishes.length"), 2);
assert.match(reloaded.run('esc(`<script>"&`)'), /&lt;script&gt;&quot;&amp;/);
assert.match(
  session("/project/missing").node("#app").innerHTML,
  /Project not found/,
);
console.log(
  "PASS: project creation, parameters, guest validation, courses, serving times, dishes, pointer reorder, Enter-to-add dishes, save button, homepage cards, resume, persistence, escaping, missing project.",
);

const deleting = session(path);
const projectId = deleting.run("project.id");
deleting.context.confirm = () => false;
deleting.node("#delete-project").onclick();
assert.equal(deleting.run("project.id"), projectId);
assert.equal(session(path).run("project.id"), projectId);
deleting.context.confirm = () => true;
const originalSet = deleting.context.localStorage.setItem;
let deletionError = false;
deleting.context.alert = () => {
  deletionError = true;
};
deleting.context.localStorage.setItem = () => {
  throw new Error("Storage unavailable");
};
deleting.node("#delete-project").onclick();
assert.equal(deletionError, true);
assert.equal(deleting.run("project.id"), projectId);
deleting.context.localStorage.setItem = originalSet;
deleting.node("#delete-project").onclick();
assert.equal(deleting.context.location.pathname, "/");
assert.doesNotMatch(deleting.node("#app").innerHTML, /Sunday supper/);
assert.match(session(path).node("#app").innerHTML, /Project not found/);
const cards = session();
cards.node("#new-project").onclick();
const cardId = cards.run("project.id");
cards.context.location.pathname = "/";
cards.run("render()");
assert.match(cards.node("#app").innerHTML, /data-delete-project/);
cards.node('[data-delete-project="' + cardId + '"]').onclick();
assert.equal(cards.run("Object.keys(projects).length"), 0);
assert.equal(session().run("Object.keys(projects).length"), 0);
console.log(
  "PASS: project deletion from editor and card, cancellation, storage failure recovery, and deletion after reload.",
);

const w = session("/recipes");
assert.match(w.node("#app").innerHTML, /Saved recipes/);
w.node("#new-recipe").onclick();
const recipePath = w.context.location.pathname,
  id = w.run("Object.keys(recipeDrafts)[0]");
const input = (selector, value) =>
  w.node(selector).oninput({ target: { value } });
input("#recipe-title", "Tomato salad");
input("#recipe-servings", "6");
w.node("#tag-input").value = "Summer, Vegetarian, summer";
w.node("#add-tag").onclick();
w.node("#tag-input").value = "";
assert.equal(w.run(`recipeDrafts['${id}'].tags.length`), 2);
input("#ingredient-0", "2 tomatoes");
w.node("#ingredient-0").onkeydown({ key: "Enter", preventDefault() {} });
input("#ingredient-1", "Fresh basil leaves");
input("#step-0", "Slice and toss.");
input("#minutes-0", "invalid");
assert.equal(w.run(`commitRecipe('${id}')`), false);
assert.match(w.node("#recipe-error").textContent, /Durations/);
input("#minutes-0", "-1");
assert.equal(w.run(`commitRecipe('${id}')`), false);
input("#minutes-0", "5.5");
assert.equal(
  session(recipePath).run(`recipeDrafts['${id}'].steps[0].minutes`),
  "5.5",
);
assert.equal(session("/recipes").run("Object.keys(savedRecipes).length"), 0);
const set = w.context.localStorage.setItem;
w.context.localStorage.setItem = () => {
  throw Error("quota");
};
assert.equal(w.run(`commitRecipe('${id}')`), false);
assert.equal(w.context.location.pathname, recipePath);
assert.equal(w.run("Object.keys(savedRecipes).length"), 0);
w.context.localStorage.setItem = set;
assert.equal(w.run(`commitRecipe('${id}')`), true);
assert.equal(w.context.location.pathname, "/recipes");
assert.match(w.node("#app").innerHTML, /Tomato salad/);
assert.equal(session("/recipes").run(`savedRecipes['${id}'].servings`), 6);
w.node("#new-recipe").onclick();
const second = w.run("Object.keys(recipeDrafts)[0]");
input("#recipe-title", "Soup");
input("#ingredient-0", "1 tomato");
input("#step-0", "Simmer");
input("#minutes-0", "20");
w.run(`commitRecipe('${second}')`);
w.run("createProject()");
const pp = w.context.location.pathname;
w.run(
  'addCourse();addDish(project.courses[0]);addDish(project.courses[0]);project.courses[0].dishes[0].name="Salad";project.courses[0].dishes[1].name="Soup";',
);
w.node("#finalize").onclick();
assert.match(w.node("#recipes-panel").innerHTML, /Find a recipe/);
const firstDish = w.run("project.courses[0].dishes[0].id");
w.node("#attach-0").onclick();
assert.equal(w.run("project.courses[0].dishes[0].recipe.id"), id);
assert.equal(w.run("project.recipeDishId"), firstDish);
assert.match(
  w.node("#recipes-panel").innerHTML,
  /aria-label="Attached recipe"/,
);
assert.equal(session(pp).run("project.recipeDishId"), firstDish);
w.node("#select-dish-1").onclick();
w.node("#create-for-dish").onclick();
const custom = w.run("Object.keys(recipeDrafts)[0]");
assert.equal(w.run(`recipeDrafts['${custom}'].title`), "Soup");
input("#ingredient-0", "tomatoes");
input("#step-0", "Cook");
input("#minutes-0", "10");
w.node("#tag-input").value = "";
w.node("#recipe-form").onsubmit({ preventDefault() {} });
assert.equal(w.context.location.pathname, pp);
assert.equal(w.run("project.courses[0].dishes[1].recipe.id"), custom);
assert.equal(w.run("project.activeTab"), "recipes");
w.node("#continue-ingredients").onclick();
assert.match(
  w.node("#ingredients-panel").innerHTML,
  /<span class="ingredient-name">2 tomatoes<\/span>/,
);
assert.match(
  w.node("#ingredients-panel").innerHTML,
  /<span class="ingredient-name">Fresh basil leaves<\/span>/,
);
w.run(`navigate('/recipe/edit/${id}')`);
input("#recipe-title", "Updated salad");
w.node("#tag-input").value = "";
w.node("#recipe-form").onsubmit({ preventDefault() {} });
assert.equal(w.context.location.pathname, "/recipes");
w.run(`navigate('${pp}')`);
assert.equal(
  w.run("attachedRecipe(project.courses[0].dishes[0]).title"),
  "Updated salad",
);
w.run(
  'setTab("recipes");project.recipeDishId=project.courses[0].dishes[0].id;delete project.courses[0].dishes[0].recipe;drawRecipes()',
);
w.node("#skip-recipe").onclick();
assert.equal(w.run("project.courses[0].dishes[0].recipeSkipped"), true);
assert.doesNotMatch(source, /\/api\/recipes|spoonacular/i);
console.log(
  "PASS: recipe library, custom tags and deduplication, ingredients, Enter-to-add, step durations, validation, draft reload, storage failure rollback, saved cards, attachment, sequential selection, create within project and return, editing shared recipes, ingredient aggregation, skip, and zero online recipe requests.",
);
const enhancements = session("/recipes");
enhancements
  .node("#recipe-search")
  .oninput({ target: { value: "vEgEtArIaN" } });
assert.match(enhancements.node("#library-results").innerHTML, /Updated salad/);
assert.doesNotMatch(enhancements.node("#library-results").innerHTML, />Soup</);
enhancements
  .node("#recipe-search")
  .oninput({ target: { value: "Updated" } });
assert.match(enhancements.node("#library-results").innerHTML, /Updated salad/);
enhancements
  .node("#recipe-search")
  .oninput({ target: { value: "nonexistent" } });
assert.match(
  enhancements.node("#library-results").innerHTML,
  /No recipes match/,
);
enhancements.node("#new-recipe").onclick();
const draftId = enhancements.run("Object.keys(recipeDrafts)[0]");
enhancements.node("#tag-input").value = "veg";
enhancements.node("#tag-input").oninput();
assert.match(enhancements.node("#tag-suggestions").innerHTML, /Vegetarian/);
assert.doesNotMatch(enhancements.node("#tag-suggestions").innerHTML, /Summer/);
enhancements.node("#suggest-tag-0").onclick();
enhancements.node("#tag-input").value = "";
assert.equal(
  enhancements.run(`recipeDrafts['${draftId}'].tags[0]`),
  "Vegetarian",
);
enhancements
  .node("#ingredient-0")
  .oninput({ target: { value: "cancel this" } });
enhancements
  .node("#ingredient-0")
  .onkeydown({ key: "Escape", preventDefault() {} });
assert.equal(
  enhancements.run(`recipeDrafts['${draftId}'].ingredients.length`),
  0,
);
enhancements.node("#add-ingredient").onclick();
enhancements.node("#ingredient-0").oninput({ target: { value: "Salt" } });
enhancements.node("#ingredient-0").onfocus();
enhancements.node("#ingredient-0").oninput({ target: { value: "Pepper" } });
enhancements
  .node("#ingredient-0")
  .onkeydown({ key: "Escape", preventDefault() {} });
assert.equal(
  enhancements.run(`recipeDrafts['${draftId}'].ingredients[0]`),
  "Salt",
);
enhancements.run(
  `navigate('${pp}');project.recipeDishId=project.courses[0].dishes[1].id;setTab('recipes')`,
);
const recipeCount = enhancements.run("Object.keys(savedRecipes).length");
assert.match(enhancements.node("#recipes-panel").innerHTML, /Unattach recipe/);
enhancements.node("#unattach-recipe").onclick();
assert.equal(
  enhancements.run("project.courses[0].dishes[1].recipe"),
  undefined,
);
assert.equal(enhancements.run("Object.keys(savedRecipes).length"), recipeCount);
assert.equal(session(pp).run("project.courses[0].dishes[1].recipe"), undefined);
enhancements.run('setTab("ingredients")');
assert.match(
  enhancements.node("#ingredients-panel").innerHTML,
  /0 ingredients/,
);
enhancements.run('setTab("planner");addDish(project.courses[0])');
const cancelDish = enhancements.run("project.courses[0].dishes.at(-1).id");
enhancements
  .node(`[data-dish="${cancelDish}"]`)
  .oninput({ target: { value: "Cancelled" } });
enhancements
  .node(`[data-dish="${cancelDish}"]`)
  .onkeydown({ key: "Escape", preventDefault() {} });
assert.equal(enhancements.run("project.courses[0].dishes.length"), 2);
const editDish = enhancements.run("project.courses[0].dishes[0].id");
enhancements.run(
  `project.courses[0].dishes[0].recipe={provider:'custom',id:'${id}'};drawCourses()`,
);
const editInput = enhancements.node(`[data-dish="${editDish}"]`);
editInput.onfocus();
editInput.oninput({ target: { value: "Wrong name" } });
editInput.onkeydown({ key: "Escape", preventDefault() {} });
assert.equal(enhancements.run("project.courses[0].dishes[0].name"), "Salad");
assert.equal(enhancements.run("project.courses[0].dishes[0].recipe.id"), id);
console.log(
  "PASS: case-insensitive tag filtering, empty results, autocomplete selection, Escape cancels new entries and restores edits and attachments, unattach persists and updates ingredients without deleting saved recipes.",
);

enhancements.run(
  "savedRecipes[project.courses[0].dishes[0].recipe.id].ingredients=['maple or honey','Maple or honey','Fresh basil leaves','Salt, to taste'];setTab('ingredients')",
);
const fullIngredients = enhancements.node("#ingredients-panel").innerHTML;
assert.match(
  fullIngredients,
  /<span class="ingredient-name">maple or honey<\/span>/,
);
assert.equal(
  (
    fullIngredients.match(
      /<span class="ingredient-name">maple or honey<\/span>/gi,
    ) || []
  ).length,
  1,
);
assert.match(
  fullIngredients,
  /<span class="ingredient-name">Fresh basil leaves<\/span>/,
);
assert.match(
  fullIngredients,
  /<span class="ingredient-name">Salt, to taste<\/span>/,
);
console.log(
  "PASS: project ingredients preserve full names, alternatives, casing and preparation notes while deduplicating matching entries.",
);
// A shared ingredient retains both dish associations, but only one label per dish.
const originalQuery = enhancements.context.document.querySelectorAll;
const sourceButtons = [];
enhancements.context.document.querySelectorAll = (selector) => {
  if (selector !== "[data-ingredient-dish]") return originalQuery(selector);
  sourceButtons.length = 0;
  for (const match of enhancements
    .node("#ingredients-panel")
    .innerHTML.matchAll(/data-ingredient-dish="([^"]+)"/g))
    sourceButtons.push({ dataset: { ingredientDish: match[1] } });
  return sourceButtons;
};
enhancements.run(
  `project.courses[0].dishes[1].recipe={provider:'custom',id:'${custom}'};savedRecipes['${custom}'].ingredients=['MAPLE OR HONEY','Pepper'];setTab('ingredients')`,
);
const sharedHTML = enhancements.node("#ingredients-panel").innerHTML;
const sharedRow = sharedHTML
  .split("<li>")
  .find((row) => row.includes("maple or honey"))
  .split("</li>")[0];
assert.equal((sharedRow.match(/data-ingredient-dish=/g) || []).length, 2);
assert.match(sharedRow, />Salad<\/button>/);
assert.match(sharedRow, />Soup<\/button>/);
assert.match(sharedRow, /title="Recipe: Updated salad"/);
assert.equal(
  (sharedHTML.match(/class="ingredient-name">maple or honey/g) || []).length,
  1,
);
const soupId = enhancements.run("project.courses[0].dishes[1].id");
sourceButtons.find((b) => b.dataset.ingredientDish === soupId).onclick();
assert.equal(enhancements.run("project.activeTab"), "recipes");
assert.equal(enhancements.run("project.recipeDishId"), soupId);
assert.match(
  enhancements.node("#recipes-panel").innerHTML,
  /Attached: <strong>Soup/,
);
enhancements.run(
  'delete project.courses[0].dishes[1].recipe;setTab("ingredients")',
);
assert.doesNotMatch(
  enhancements.node("#ingredients-panel").innerHTML,
  />Soup<\/button>/,
);
const ingredientCSS = readFileSync(
  new URL("./public/style.css", import.meta.url),
  "utf8",
);
assert.match(
  ingredientCSS,
  /\.ingredient-list\s*\{[^}]*grid-template-columns:\s*1fr/,
);
assert.doesNotMatch(ingredientCSS, /\.ingredient-list\s*\{[^}]*repeat\(2/);
console.log(
  "PASS: shared ingredient dish labels, duplicate association prevention, recipe titles, source navigation, unattach refresh, and single-column layout.",
);
enhancements.run(
  'project.recipeDishId=project.courses[0].dishes[0].id;setTab("recipes")',
);
const attachedView = enhancements.node("#recipes-panel").innerHTML;
assert.match(attachedView, /aria-label="Attached recipe"/);
assert.match(attachedView, /<h3>Ingredients<\/h3>/);
assert.match(attachedView, /<h3>Steps<\/h3>/);
assert.match(attachedView, /Slice and toss\./);
assert.match(attachedView, /5.5 min/);
assert.doesNotMatch(
  attachedView,
  /Find a recipe|Create new recipe|id="attach-/,
);
enhancements.node("#unattach-recipe").onclick();
assert.match(
  enhancements.node("#recipes-panel").innerHTML,
  /Find a recipe/,
);
assert.doesNotMatch(
  enhancements.node("#recipes-panel").innerHTML,
  /aria-label="Attached recipe"/,
);
console.log(
  "PASS: selected dishes display attached recipe ingredients and timed steps, hide the chooser, and restore it after unattach.",
);
const bulk = session();
bulk.run(
  `savedRecipes.bulk={id:'bulk',title:'Bulk recipe',servings:4,tags:[],ingredients:['Salt, to taste','Pepper','Maple or honey'],steps:[{text:'Mix',minutes:1}]};createProject();project.courses=[{id:'bulk-course',name:'Main',time:'',dishes:[{id:'bulk-dish',name:'Dinner',recipe:{provider:'custom',id:'bulk'}}]}];setTab('ingredients');`,
);
const bulkPath = bulk.context.location.pathname;
const selectRow = (i) =>
  bulk.node("#ingredient-select-" + i).onchange({ target: { checked: true } });
const names = () =>
  [
    ...bulk
      .node("#ingredients-panel")
      .innerHTML.matchAll(/class="ingredient-name">([^<]*)<\/span>/g),
  ].map((m) => m[1]);
assert.deepEqual(names(), ["Maple or honey", "Pepper", "Salt, to taste"]);
selectRow(0);
assert.equal(bulk.node("#ingredients-select-all").indeterminate, true);
assert.equal(bulk.node("#ingredients-combine").disabled, true);
selectRow(1);
assert.equal(
  bulk.node("#ingredient-selection-count").textContent,
  "2 selected",
);
assert.equal(bulk.node("#ingredients-combine").disabled, false);
bulk.node("#ingredients-combine").onclick();
assert.deepEqual(names(), ["Maple or honey, Pepper", "Salt, to taste"]);
assert.equal(bulk.run("project.ingredientEdits.groups[0].keys.length"), 2);
assert.equal(
  (
    bulk
      .node("#ingredients-panel")
      .innerHTML.split("<li>")[1]
      .match(/data-ingredient-dish=/g) || []
  ).length,
  1,
);
assert.match(
  session(bulkPath).node("#ingredients-panel").innerHTML,
  /Maple or honey, Pepper/,
);
selectRow(0);
bulk.node("#ingredients-omit").onclick();
assert.match(
  bulk.node("#ingredients-panel").innerHTML,
  /ingredient-entry ingredient-omitted/,
);
assert.equal(bulk.run("project.ingredientEdits.omitted.length"), 2);
assert.match(
  session(bulkPath).node("#ingredients-panel").innerHTML,
  /ingredient-entry ingredient-omitted/,
);
selectRow(0);
bulk.node("#ingredient-separate-0").onclick();
assert.deepEqual(names(), ["Maple or honey", "Pepper", "Salt, to taste"]);
assert.equal(bulk.run("project.ingredientEdits.groups.length"), 0);
assert.equal(
  (
    bulk
      .node("#ingredients-panel")
      .innerHTML.match(/ingredient-entry ingredient-omitted/g) || []
  ).length,
  2,
);
bulk.node("#ingredients-select-all").onchange({ target: { checked: true } });
assert.equal(
  bulk.node("#ingredient-selection-count").textContent,
  "3 selected",
);
bulk.node("#ingredient-include-0").onclick();
bulk.node("#ingredient-include-1").onclick();
assert.equal(bulk.run("project.ingredientEdits.omitted.length"), 0);
selectRow(1);
selectRow(2);
bulk.node("#ingredients-combine").onclick();
assert.deepEqual(names(), ["Maple or honey", "Pepper, Salt, to taste"]);
selectRow(0);
selectRow(1);
bulk.node("#ingredients-combine").onclick();
assert.deepEqual(names(), ["Maple or honey, Pepper, Salt, to taste"]);
selectRow(0);
bulk.node("#ingredient-separate-0").onclick();
assert.deepEqual(names(), ["Maple or honey", "Pepper", "Salt, to taste"]);
bulk.run("project.ingredientEdits.deleted=['pepper'];save();drawIngredients()");
assert.deepEqual(names(), ["Maple or honey", "Pepper", "Salt, to taste"]);
assert.doesNotMatch(
  bulk.node("#ingredients-panel").innerHTML,
  /ingredients-delete|restore-deleted-ingredients/,
);
assert.match(session(bulkPath).node("#ingredients-panel").innerHTML, /Pepper/);
console.log(
  "PASS: multi-selection, select all, selection counts, combine and separate including embedded commas and nested combinations, omission and inclusion, legacy deleted entries restored, dish provenance, persisted edits, and unchanged source recipes.",
);

assert.doesNotMatch(
  bulk.node("#ingredients-panel").innerHTML,
  /id="ingredients-(?:include|separate)"/,
);
assert.doesNotMatch(
  bulk.node("#ingredients-panel").innerHTML,
  /id="ingredient-(?:include|separate)-/,
);
selectRow(0);
bulk.node("#ingredients-omit").onclick();
assert.match(
  bulk.node("#ingredients-panel").innerHTML,
  /id="ingredient-include-0"/,
);
assert.doesNotMatch(
  bulk.node("#ingredients-panel").innerHTML,
  /id="ingredient-include-1"/,
);
bulk.node("#ingredient-include-0").onclick();
assert.equal(bulk.run("project.ingredientEdits.omitted.length"), 0);
selectRow(0);
selectRow(1);
bulk.node("#ingredients-combine").onclick();
assert.match(
  bulk.node("#ingredients-panel").innerHTML,
  /id="ingredient-separate-0"/,
);
bulk.node("#ingredient-separate-0").onclick();
assert.equal(names().length, 3);
console.log(
  "PASS: Include and Separate appear only on eligible rows and work without selecting those rows.",
);
const steps = session("/recipes");
steps.node("#new-recipe").onclick();
const stepsPath = steps.context.location.pathname,
  stepsId = steps.run("Object.keys(recipeDrafts).at(-1)");
steps.run(
  `recipeDrafts['${stepsId}'].title='Step order';recipeDrafts['${stepsId}'].ingredients=['Salt'];recipeDrafts['${stepsId}'].steps=[{text:'Chop',minutes:3},{text:'Cook',minutes:15},{text:'Serve',minutes:1}];showRecipeEditor('${stepsId}')`,
);
function dragStep(from, y, cancel = false) {
  for (let i = 0; i < 3; i++)
    steps.node("#step-row-" + i).getBoundingClientRect = () => ({
      top: 100 + i * 200,
      height: 180,
    });
  const handle = steps.node("#step-grip-" + from);
  handle.setPointerCapture = () => {};
  handle.hasPointerCapture = () => true;
  handle.releasePointerCapture = () => {};
  handle.onpointerdown({ button: 0, pointerId: 1, preventDefault() {} });
  handle.onpointermove({ clientY: y });
  if (cancel) handle.onpointercancel({ type: "pointercancel" });
  else handle.onpointerup({ type: "pointerup" });
}
dragStep(0, 750);
assert.equal(steps.run(`recipeDrafts['${stepsId}'].steps[2].text`), "Chop");
assert.equal(steps.run(`recipeDrafts['${stepsId}'].steps[2].minutes`), 3);
assert.equal(steps.focused, "#step-grip-2");
assert.equal(
  session(stepsPath).run(`recipeDrafts['${stepsId}'].steps[0].text`),
  "Cook",
);
dragStep(2, 50, true);
assert.equal(steps.run(`recipeDrafts['${stepsId}'].steps[2].text`), "Chop");
dragStep(2, 50);
assert.equal(steps.run(`recipeDrafts['${stepsId}'].steps[0].text`), "Chop");
steps
  .node("#step-grip-0")
  .onkeydown({ altKey: true, key: "ArrowDown", preventDefault() {} });
assert.equal(steps.run(`recipeDrafts['${stepsId}'].steps[1].text`), "Chop");
steps.node("#step-1").oninput({ target: { value: "Chop finely" } });
steps.node("#minutes-1").oninput({ target: { value: "4" } });
steps.run(`commitRecipe('${stepsId}')`);
assert.equal(
  session("/recipes").run(`savedRecipes['${stepsId}'].steps[1].text`),
  "Chop finely",
);
assert.equal(
  session("/recipes").run(`savedRecipes['${stepsId}'].steps[1].minutes`),
  4,
);
console.log(
  "PASS: step pointer reordering in both directions, cancellation, duration pairing, draft persistence, keyboard alternative, edits after reorder, and saved order.",
);
const quantity = session("/recipes");
quantity.node("#new-recipe").onclick();
const quantityId = quantity.run("Object.keys(recipeDrafts).at(-1)"),
  quantityPath = quantity.context.location.pathname;
quantity.node("#ingredient-0").oninput({ target: { value: "Flour" } });
quantity.node("#quantity-0").oninput({ target: { value: "½ cup" } });
quantity.node("#quantity-0").onkeydown({ key: "Enter", preventDefault() {} });
quantity.node("#ingredient-1").oninput({ target: { value: "Salt" } });
quantity.node("#quantity-1").oninput({ target: { value: "1 tsp" } });
assert.equal(
  session(quantityPath).run(
    `recipeDrafts['${quantityId}'].ingredientQuantities[1]`,
  ),
  "1 tsp",
);
quantity.node("#quantity-1").onfocus();
quantity.node("#quantity-1").oninput({ target: { value: "Wrong" } });
quantity.node("#quantity-1").onkeydown({ key: "Escape", preventDefault() {} });
assert.equal(
  quantity.run(`recipeDrafts['${quantityId}'].ingredientQuantities[1]`),
  "1 tsp",
);
quantity.node("#remove-ingredient-0").onclick();
assert.equal(
  quantity.run(`recipeDrafts['${quantityId}'].ingredientQuantities[0]`),
  "1 tsp",
);
quantity.node("#add-ingredient").onclick();
quantity.node("#quantity-1").oninput({ target: { value: "unused blank row" } });
quantity.node("#recipe-title").oninput({ target: { value: "Quantities" } });
quantity.node("#step-0").oninput({ target: { value: "Mix" } });
quantity.node("#minutes-0").oninput({ target: { value: "1" } });
quantity.run(`commitRecipe('${quantityId}')`);
assert.equal(
  quantity.run(`savedRecipes['${quantityId}'].ingredientQuantities.length`),
  1,
);
assert.equal(
  quantity.run(`savedRecipes['${quantityId}'].ingredientQuantities[0]`),
  "1 tsp",
);
assert.match(
  quantity.run(`attachedRecipeMarkup(savedRecipes['${quantityId}'])`),
  /1 tsp Salt/,
);
const editQuantity = session("/recipe/edit/" + quantityId);
assert.match(
  editQuantity.node("#app").innerHTML,
  /id="quantity-0"[^>]*value="1 tsp"/,
);
console.log(
  "PASS: optional ingredient quantities, Enter and Escape, draft reload, deletion alignment, blank-row filtering, saved editing, and recipe quantity display.",
);
assert.doesNotMatch(
  session("/recipes").node("#app").innerHTML,
  /import-recipe/,
);
assert.match(
  session("/recipes").node("#app").innerHTML,
  /Find a recipe or paste a link/,
);
assert.match(session("/recipes").node("#app").innerHTML, /role="combobox"/);
const importer = session("/recipe/new/import-draft");
importer.run(
  `recipeDrafts['import-draft']={id:'import-draft',title:'',servings:4,tags:[],ingredients:[''],steps:[{text:'',minutes:''}],returnTo:null};showRecipeEditor('import-draft');`,
);
assert.match(importer.node("#app").innerHTML, /id="import-from-url"/);
assert.match(importer.node("#app").innerHTML, /id="import-from-text"/);
importer.run(
  `applyImportedRecipe(recipeDrafts['import-draft'], {title:'Imported soup', yield:{raw:'4 servings',servings:4}, ingredients:[{raw:'1 onion'}], steps:[{text:'Simmer gently.', minutes:null}], source:{url:'https://recipes.example.com/soup'}});`,
);
assert.equal(importer.run(`recipeDrafts['import-draft'].title`), "Imported soup");
assert.equal(importer.run(`recipeDrafts['import-draft'].ingredients[0]`), "1 onion");
assert.equal(importer.run(`recipeDrafts['import-draft'].steps[0].minutes`), "");
assert.equal(
  importer.run(`recipeDrafts['import-draft'].sourceUrl`),
  "https://recipes.example.com/soup",
);
const pasted = session("/recipe/new/paste-draft", {
  fetch: async (url, options) => {
    assert.equal(String(url), "/api/recipe-import");
    assert.equal(JSON.parse(options.body).text.includes("Ingredients"), true);
    return {
      ok: true,
      json: async () => ({
        status: "ready_for_review",
        warnings: [],
        recipes: [
          {
            title: "Pasted salad",
            yield: { raw: "", servings: null },
            ingredients: [{ raw: "1 test cucumber" }],
            steps: [{ text: "Slice thinly.", minutes: null }],
            source: { extractor: "labelled-text", fetchedAt: "2026-09-12T00:00:00.000Z", version: "1" },
            warnings: [],
          },
        ],
      }),
    };
  },
});
pasted.run(
  `recipeDrafts['paste-draft']={id:'paste-draft',title:'',servings:4,tags:[],ingredients:[''],steps:[{text:'',minutes:''}],returnTo:null};showRecipeEditor('paste-draft');`,
);
pasted.node("#import-text").value =
  "Pasted salad\n\nIngredients\n- 1 test cucumber\n\nInstructions\n1. Slice thinly.";
await pasted.node("#import-from-text").onclick();
assert.equal(pasted.run(`recipeDrafts['paste-draft'].title`), "Pasted salad");
assert.equal(
  pasted.run(`recipeDrafts['paste-draft'].steps[0].minutes`),
  "",
);
assert.match(
  pasted.run(`recipeDrafts['paste-draft'].importNotice`),
  /times|timing|duration/,
);
console.log(
  "PASS: recipe URL/text import fills a reviewable draft without inventing step durations.",
);
const finder = session("/recipes", {
  fetch: async (url, options) => {
    if (String(url).includes("/api/recipe-search")) {
      return {
        ok: true,
        json: async () => ({
          query: "pad",
          provider: "brave",
          results: [
            {
              id: "webpad",
              url: "https://recipes.example.com/pad-thai",
              title: "Weeknight Pad Thai",
              source: "recipes.example.com",
              snippet: "Tamarind noodles.",
            },
          ],
          hasMore: false,
        }),
      };
    }
    if (String(url) === "/api/recipe-import") {
      assert.equal(
        JSON.parse(options.body).url,
        "https://recipes.example.com/pad-thai",
      );
      return {
        ok: true,
        json: async () => ({
          status: "ready_for_review",
          warnings: [],
          recipes: [
            {
              title: "Weeknight Pad Thai",
              yield: { raw: "4 servings", servings: 4 },
              ingredients: [{ raw: "8 oz rice noodles" }, { raw: "2 eggs" }],
              steps: [
                { text: "Soak the noodles.", minutes: null },
                { text: "Stir-fry quickly.", minutes: null },
              ],
              source: {
                url: "https://recipes.example.com/pad-thai",
                extractor: "schema.org-jsonld",
                fetchedAt: "2026-09-12T00:00:00.000Z",
                version: "1",
              },
              warnings: [],
            },
          ],
        }),
      };
    }
    throw new Error("unexpected fetch " + url);
  },
});
finder.run(
  "savedRecipes.padLocal={id:'padLocal',title:'Home pad thai',servings:2,tags:['Thai'],ingredients:['rice noodles'],steps:[{text:'Boil',minutes:10}]};render()",
);
assert.equal(finder.run("looksLikeHttpUrl('https://recipes.example.com/x')"), true);
assert.equal(finder.run("looksLikeHttpUrl('pad thai')"), false);
finder.node("#recipe-search").oninput({ target: { value: "pad" } });
assert.match(finder.node("#library-results").innerHTML, /Home pad thai/);
assert.match(finder.node("#recipe-search-list").innerHTML, /Your recipes/);
assert.match(
  finder.node("#recipe-search-list").innerHTML,
  /Home <mark class="recipe-search-mark">pad<\/mark> thai/,
);
await new Promise((resolve) => setTimeout(resolve, 450));
assert.match(finder.node("#recipe-search-list").innerHTML, /From the web/);
assert.match(
  finder.node("#recipe-search-list").innerHTML,
  /Weeknight <mark class="recipe-search-mark">Pad<\/mark> Thai/,
);
const savedCount = finder.run("Object.keys(savedRecipes).length");
finder.node("#recipe-search-option-1").onclick();
await new Promise((resolve) => setTimeout(resolve, 30));
const importedId = finder.run("Object.keys(recipeDrafts).at(-1)");
assert.match(finder.context.location.pathname, /\/recipe\/new\//);
assert.equal(
  finder.run(`recipeDrafts['${importedId}'].title`),
  "Weeknight Pad Thai",
);
assert.equal(
  finder.run(`recipeDrafts['${importedId}'].ingredients[0]`),
  "8 oz rice noodles",
);
assert.equal(finder.run(`recipeDrafts['${importedId}'].steps.length`), 2);
assert.equal(
  finder.run(`recipeDrafts['${importedId}'].steps[0].minutes`),
  "",
);
assert.equal(finder.run(`savedRecipes['${importedId}']`), undefined);
assert.equal(finder.run("Object.keys(savedRecipes).length"), savedCount);
assert.match(finder.node("#app").innerHTML, /Save recipe/);
assert.match(finder.node("#app").innerHTML, /Soak the noodles/);
console.log(
  "PASS: Google-style recipe search opens a populated draft without saving it to the library.",
);
let searchCalls = 0;
const searchCache = session("/recipes", {
  fetch: async (url) => {
    if (String(url).includes("/api/recipe-search")) {
      searchCalls += 1;
      if (searchCalls > 1) {
        return {
          ok: false,
          status: 502,
          json: async () => ({
            error: {
              code: "PROVIDER_BAD_RESPONSE",
              message: "blocked",
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          query: "soup",
          provider: "open",
          results: [
            {
              id: "oncesoup",
              url: "https://recipes.example.com/soup",
              title: "Once soup",
              source: "recipes.example.com",
              snippet: "A bowl.",
            },
          ],
          hasMore: false,
        }),
      };
    }
    throw new Error("unexpected fetch " + url);
  },
});
searchCache.node("#recipe-search").oninput({ target: { value: "soup" } });
await new Promise((resolve) => setTimeout(resolve, 450));
assert.match(
  searchCache.node("#recipe-search-list").innerHTML,
  /Once <mark class="recipe-search-mark">soup<\/mark>/,
);
assert.equal(searchCalls, 1);
searchCache.node("#recipe-search").onfocus();
await new Promise((resolve) => setTimeout(resolve, 450));
assert.match(
  searchCache.node("#recipe-search-list").innerHTML,
  /Once <mark class="recipe-search-mark">soup<\/mark>/,
);
assert.doesNotMatch(
  searchCache.node("#recipe-search-list").innerHTML,
  /unavailable|blocked/i,
);
assert.equal(searchCalls, 1);
console.log(
  "PASS: repeating the same recipe search keeps the first successful results.",
);
const timeline = session();
timeline.run(
  `savedRecipes.timelineRecipe={id:'timelineRecipe',title:'Dinner',servings:4,tags:[],ingredients:['salt'],steps:[{text:'Chop vegetables',minutes:10},{text:'Cook gently',minutes:20},{text:'Plate dinner',minutes:5}]};createProject();project.courses=[{id:'c1',name:'Main',time:'18:00',dishes:[{id:'d1',name:'Dish one',recipe:{provider:'custom',id:'timelineRecipe'}},{id:'d2',name:'Dish two',recipe:{provider:'custom',id:'timelineRecipe'}}]},{id:'c2',name:'Dessert',time:'18:30',dishes:[{id:'d3',name:'Dish three',recipe:{provider:'custom',id:'timelineRecipe'}}]}];setTab('timeline');`,
);
const timelinePath = timeline.context.location.pathname;
const model = () =>
  JSON.parse(
    timeline.run("JSON.stringify(timelineModel(project,savedRecipes))"),
  );
assert.equal(model().dishes[0].blocks[0].start, 1045);
assert.equal(model().dishes[0].blocks[2].end, 1080);
assert.equal(model().dishes[2].blocks[2].end, 1110);
assert.equal(model().blocks.length, 9);
assert.equal(model().services.length, 2);
assert.notEqual(model().dishes[0].color, model().dishes[1].color);
assert.match(timeline.node("#timeline-panel").innerHTML, />Chop<\/button>/);
assert.match(
  timeline.node("#timeline-panel").innerHTML,
  /title="Dish one · Step 1&#10;Chop vegetables&#10;10 min/,
);
const blockStyles = [
  ...timeline
    .node("#timeline-panel")
    .innerHTML.matchAll(/id="tl-block-\d+"[^>]*style="([^"]+)"/g),
].map((m) => m[1]);
assert.notEqual(
  blockStyles[0].match(/top:([^;]+)/)[1],
  blockStyles[3].match(/top:([^;]+)/)[1],
);
timeline.run("shiftTimeline('d1',1,15);drawTimeline()");
assert.equal(model().dishes[0].blocks[0].start, 1045);
assert.equal(model().dishes[0].blocks[1].start, 1070);
assert.equal(model().dishes[0].blocks[2].end, 1095);
assert.equal(model().dishes[1].blocks[1].start, 1055);
assert.equal(
  session(timelinePath).run(
    "timelineModel(project,savedRecipes).dishes[0].blocks[1].start",
  ),
  1070,
);
timeline.node("#tl-planner-toggle").onclick();
assert.equal(timeline.run("project.timeline.plannerOpen"), true);
const planner = timeline
  .node("#timeline-panel")
  .innerHTML.split('class="tl-planner"')[1];
assert.ok(planner.indexOf("17:25") < planner.indexOf("17:35"));
assert.match(planner, /Cook gently/);
timeline.node("#tl-planner-close").onclick();
assert.equal(timeline.run("project.timeline.plannerOpen"), false);
timeline.node("#tl-zoom").oninput({ target: { value: "8" } });
assert.equal(timeline.run("project.timeline.zoom"), 8);
assert.ok(
  timeline
    .node("#timeline-panel")
    .innerHTML.includes(
      "width:" + Math.max(800, (model().max - model().min) * 8) + "px",
    ),
);
timeline.node("#tl-reset").onclick();
assert.equal(model().dishes[0].blocks[2].end, 1080);
// Drive the actual drag handlers; a middle step moves together with only its downstream steps.
const tlScroll = timeline.node("#tl-scroll");
tlScroll.scrollLeft = 0;
tlScroll.getBoundingClientRect = () => ({ left: 0, right: 1000 });
for (let i = 0; i < 9; i++) timeline.node("#tl-block-" + i).style = {};
const tlHandle = timeline.node("#tl-block-1");
tlHandle.setPointerCapture = () => {};
tlHandle.hasPointerCapture = () => true;
tlHandle.releasePointerCapture = () => {};
tlHandle.onpointerdown({
  button: 0,
  pointerId: 1,
  clientX: 300,
  preventDefault() {},
});
tlHandle.onpointermove({ clientX: 374 });
assert.equal(timeline.node("#tl-block-2").style.transform, "translateX(80px)");
assert.equal(timeline.node("#tl-block-0").style.transform, undefined);
tlHandle.onpointerup({ type: "pointerup" });
assert.equal(model().dishes[0].blocks[1].start, 1065);
assert.equal(model().dishes[0].blocks[2].end, 1090);
timeline.node("#tl-reset").onclick();
timeline.run(
  "savedRecipes.timelineRecipe.steps[1].text='Changed recipe';savedRecipes.timelineRecipe.steps[1].minutes='';drawTimeline()",
);
assert.equal(model().blocks.length, 0);
assert.equal(model().issues.length, 3);
timeline.run(
  "savedRecipes.timelineRecipe.steps[1].minutes=20;project.courses[0].time='00:10';project.courses[1].time='00:05';drawTimeline()",
);
assert.equal(model().dishes[0].blocks[0].start, -25);
assert.equal(model().services[1].time, 1445);
assert.equal(timeline.run("timelineTime(-25)"), "23:35 (-1d)");
console.log(
  "PASS: backward scheduling, all steps, service markers, colors, overlap stacking, downstream-only drag and persistence, filters, chronological drawer, zoom, reset, missing durations, and midnight rollover.",
);

// Tooltip content and controls are wired to the rendered timeline, not just the schedule model.
timeline.node("#tl-tooltip").style = {};
timeline.node("#tl-tooltip").offsetHeight = 120;
timeline.node("#tl-block-0").onmouseenter({ clientX: 300, clientY: 200 });
assert.match(timeline.node("#tl-tooltip").innerHTML, /Chop vegetables/);
assert.match(timeline.node("#tl-tooltip").innerHTML, /10 min/);
assert.equal(timeline.node("#tl-tooltip").hidden, false);
timeline.node("#tl-block-0").onmouseleave();
assert.equal(timeline.node("#tl-tooltip").hidden, true);
timeline.run(
  "shiftTimeline('d1',0,15);savedRecipes.timelineRecipe.steps[0].text='New instructions';drawTimeline()",
);
assert.equal(model().dishes[0].blocks[0].start, -25);
timeline.run("savedRecipes.timelineRecipe.steps[0].minutes=0;drawTimeline()");
assert.equal(model().blocks.length, 9);
assert.equal(model().dishes[0].blocks[0].duration, 0);
timeline.node("#planner-tab").onkeydown({ key: "End", preventDefault() {} });
assert.equal(timeline.run("project.activeTab"), "timeline");
timeline
  .node("#timeline-tab")
  .onkeydown({ key: "ArrowRight", preventDefault() {} });
assert.equal(timeline.run("project.activeTab"), "planner");
console.log(
  "PASS: full hover details, stale schedule edits invalidated after recipe changes, zero-duration steps retained, and four-tab keyboard navigation.",
);
// A corrupt workspace and edits from an older tab must never replace persisted work.
const priorData = saved.get("mise-studio-data-v2");
saved.set("mise-studio-data-v2", "{broken");
const corrupt = session();
assert.match(
  corrupt.node("#app").innerHTML,
  /Existing data has been preserved/,
);
corrupt.run("createProject()");
assert.equal(saved.get("mise-studio-data-v2"), "{broken");
assert.equal(corrupt.run("storageReadFailed"), true);
saved.set("mise-studio-data-v2", priorData);
const tabA = session(),
  tabB = session();
tabA.run("createProject()");
const tabAData = saved.get("mise-studio-data-v2");
tabB.run("createProject()");
assert.equal(tabB.run("storageConflict"), true);
assert.equal(saved.get("mise-studio-data-v2"), tabAData);
const continued = session();
continued.run('createProject();setTab("ingredients")');
assert.match(
  continued.node("#ingredients-panel").innerHTML,
  /continue-timeline/,
);
continued.node("#continue-timeline").onclick();
assert.equal(continued.run("project.activeTab"), "timeline");
console.log(
  "PASS: corrupt-data write protection, stale-tab conflict protection, and Ingredients-to-Timeline continuation.",
);
const axis=session();axis.run(`savedRecipes.axisRecipe={id:'axisRecipe',title:'Row test',servings:4,tags:[],ingredients:['Salt'],steps:[{text:'Chop vegetables',minutes:10},{text:'Cook vegetables',minutes:10},{text:'Serve vegetables',minutes:10}]};createProject();project.courses=[{id:'axis-course',name:'Main',time:'18:00',dishes:[{id:'axis-one',name:'First dish',recipe:{provider:'custom',id:'axisRecipe'}},{id:'axis-two',name:'Second dish',recipe:{provider:'custom',id:'axisRecipe'}}]}];setTab('timeline')`);
const axisPath=axis.context.location.pathname;
const rowDimensions=()=>[...axis.node('#timeline-panel').innerHTML.matchAll(/class="tl-axis-row[^"]*" style="top:(\d+)px;height:(\d+)px"/g)].map(m=>({top:Number(m[1]),height:Number(m[2])}));
assert.doesNotMatch(axis.node('#timeline-panel').innerHTML,/tl-filters|tl-dish-filter/);
assert.match(axis.node('#timeline-panel').innerHTML,/class="tl-row-axis" aria-label="Dish rows"/);
assert.match(axis.node('#timeline-panel').innerHTML,/>First dish<\/strong>/);
assert.deepEqual(rowDimensions().map(r=>r.height),[50,50]);
axis.run("shiftTimeline('axis-one',1,-15);drawTimeline()");
assert.deepEqual(rowDimensions().map(r=>r.height),[100,50]);assert.equal(rowDimensions()[1].top,rowDimensions()[0].top+100);
const expandedHTML=axis.node('#timeline-panel').innerHTML;
assert.match(expandedHTML,new RegExp('class="tl-row-band" style="top:'+rowDimensions()[0].top+'px;height:100px"'));
axis.node('#tl-reset').onclick();assert.deepEqual(rowDimensions().map(r=>r.height),[50,50]);
axis.run("project.timeline.hiddenCourses=['axis-course'];project.timeline.hiddenDishes=['axis-one'];drawTimeline()");
assert.match(axis.node('#timeline-panel').innerHTML,/data-tl-dish="axis-one"/);assert.match(axis.node('#timeline-panel').innerHTML,/data-tl-dish="axis-two"/);
assert.doesNotMatch(axis.node('#timeline-panel').innerHTML,/type="checkbox"|Toggle each row|is-hidden/);
assert.match(readFileSync(new URL('./public/style.css',import.meta.url),'utf8'),/\.tl-row-axis\s*\{[^}]*position:\s*sticky;[^}]*left:\s*0/);
console.log('PASS: left-axis dish labels, all dishes shown despite legacy filters, same-dish overlap expansion, aligned row heights, and reset.');

axis.run("shiftTimeline('axis-one',1,-2);drawTimeline()");
const snapScroll=axis.node('#tl-scroll');snapScroll.scrollLeft=0;snapScroll.getBoundingClientRect=()=>({left:0,right:1000});
for(let i=0;i<6;i++)axis.node('#tl-block-'+i).style={};
const snapHandle=axis.node('#tl-block-1');snapHandle.setPointerCapture=()=>{};snapHandle.hasPointerCapture=()=>true;snapHandle.releasePointerCapture=()=>{};
snapHandle.onpointerdown({button:0,pointerId:3,clientX:400,preventDefault(){}});snapHandle.onpointermove({clientX:420});snapHandle.onpointerup({type:'pointerup'});
assert.equal(axis.run('timelineModel(project,savedRecipes).dishes[0].blocks[1].start'),1065);
assert.equal(axis.run('timelineModel(project,savedRecipes).dishes[0].blocks[0].start'),1050);
assert.equal(axis.run('timelineModel(project,savedRecipes).dishes[0].blocks[2].start'),1075);
axis.node('#tl-block-1').onkeydown({key:'ArrowLeft',preventDefault(){}});assert.equal(axis.run('timelineModel(project,savedRecipes).dishes[0].blocks[1].start'),1060);
console.log('PASS: five-minute drag snapping from off-grid times, downstream spacing, and keyboard snapping.');
const cardLayout=session('/recipes');
cardLayout.run("savedRecipes.cardExample={id:'cardExample',title:'Card example',servings:6,tags:['Test'],ingredients:['Salt'],steps:[{text:'Prep',minutes:5},{text:'Cook',minutes:20},{text:'Serve',minutes:2.5}]};render()");
assert.match(cardLayout.node('#app').innerHTML,/Serves 6, 27.5 min across 3 steps/);
assert.doesNotMatch(cardLayout.node('#app').innerHTML,/1 ingredients · 3 steps/);
assert.match(cardLayout.node('#app').innerHTML,/id="new-recipe"/);assert.match(cardLayout.node('#app').innerHTML,/class="project-card new-recipe-card" id="new-recipe-card"/);
cardLayout.node('#recipe-search').oninput({target:{value:'nothing-matches-this-tag'}});assert.match(cardLayout.node('#library-results').innerHTML,/new-recipe-card/);
cardLayout.node('#library-results').onclick({target:{closest:selector=>selector==='#new-recipe-card'?{}:null}});assert.match(cardLayout.context.location.pathname,/\/recipe\/new\//);
assert.match(readFileSync(new URL('./public/style.css',import.meta.url),'utf8'),/\.saved-recipe-grid\s*\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
console.log('PASS: saved recipe summary, removed bottom counts, additional working recipe card after filtering, and three-column grid.');
