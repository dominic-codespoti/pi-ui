<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
  import DropdownMenuPortal from './dropdown-menu-portal.svelte';
  import { cn, type WithoutChild } from '#lib/utils.js';
  let {
    ref = $bindable(null),
    class: className,
    children,
    sideOffset = 4,
    ...restProps
  }: WithoutChild<DropdownMenuPrimitive.ContentProps> = $props();
</script>

<DropdownMenuPortal>
  <DropdownMenuPrimitive.Content
    bind:ref
    {sideOffset}
    data-slot="dropdown-menu-content"
    class={cn(
      'bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0 data-open:zoom-in-95 data-closed:zoom-out-95 min-w-36 rounded-lg shadow-md ring-1 duration-100 z-50 overflow-hidden p-1',
      className
    )}
    {...restProps}
  >
    {@render children?.()}
  </DropdownMenuPrimitive.Content>
</DropdownMenuPortal>
