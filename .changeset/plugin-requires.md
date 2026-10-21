---
'ai-sdk-harness-plugins': patch
---

A plugin can `requires`, as an item does: what it uses outside itself — an item on its own, an item of another plugin, a whole plugin —, by catalog id. Selecting the plugin in a catalog (`plugin:<name>`) selects them, and what they require in turn, each delivered as the item it is rather than copied into the plugin: a plugin follows the edits of an item published on its own. Selecting one item of the plugin brings only what that item requires. `definePlugin()` refuses a plugin that requires itself or one of its own items (an issue at `requires.<index>`), and `createCatalog()` one that requires what the catalog does not have. In `catalog.entries()`, a plugin's `requires` lists its items, then what it requires besides them; `catalog.describe()` gives the latter as the `requires` of each plugin that requires something outside itself. What a plugin requires is part of its fingerprint.
