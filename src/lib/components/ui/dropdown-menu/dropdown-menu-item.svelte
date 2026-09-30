<script lang="ts">
  import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';
  import { cn, type WithoutChild } from '#lib/utils.js';
  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithoutChild<DropdownMenuPrimitive.ItemProps> = $props();
</script>

<DropdownMenuPrimitive.Item
  bind:ref
  data-slot="dropdown-menu-item"
  class={cn(
    'focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</DropdownMenuPrimitive.Item>
