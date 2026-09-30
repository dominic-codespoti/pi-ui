<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
  import { cn, type WithoutChild } from '#lib/utils.js';
  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: WithoutChild<DropdownMenuPrimitive.SeparatorProps> = $props();
</script>

<DropdownMenuPrimitive.Separator
  bind:ref
  data-slot="dropdown-menu-separator"
  class={cn('bg-border -mx-1 my-1 h-px', className)}
  {...restProps}
/>
