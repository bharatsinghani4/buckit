"use client";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";

type Option = { value: string; label: string };
export function Dropdown({
  value,
  defaultValue,
  onValueChange,
  onOpenChange,
  options,
  name,
  disabled,
  placeholder = "Choose an option",
  id,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  options: Option[];
  name?: string;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | undefined>();
  function handleOpenChange(open: boolean) {
    if (open) setPortalContainer(trigger.current?.closest("dialog") ?? undefined);
    onOpenChange?.(open);
  }
  return (
    <Select.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      onOpenChange={handleOpenChange}
      name={name}
      disabled={disabled}
    >
      <Select.Trigger ref={trigger} id={id} className="dropdown-trigger">
        <Select.Value placeholder={placeholder} />
        <Select.Icon>
          <ChevronDown size={16} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal container={portalContainer}>
        <Select.Content position="popper" sideOffset={5} className="dropdown-content">
          <Select.ScrollUpButton className="dropdown-scroll">▲</Select.ScrollUpButton>
          <Select.Viewport className="dropdown-viewport">
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value} className="dropdown-option">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={15} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="dropdown-scroll">▼</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
