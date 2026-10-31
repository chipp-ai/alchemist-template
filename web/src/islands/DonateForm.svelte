<!--
  The DonateForm island: the Chipp Payments donation form on a
  server-rendered page.

  renderIsland("DonateForm", { productKey: "donate", title: "Support our work" }, fallbackHtml)

  The fallback should be a plain link to a page that shows the form, so a
  visitor without JavaScript can still give. Props are the component's
  own (web/src/components/chipp-payments/DonateForm.svelte).
-->
<script lang="ts">
  import DonateForm from "../components/chipp-payments/DonateForm.svelte";

  let {
    productKey,
    title,
    returnPath,
    cancelPath,
  }: { productKey: string; title?: string; returnPath?: string; cancelPath?: string } = $props();
</script>

<DonateForm {productKey} {title} {returnPath} {cancelPath} />
