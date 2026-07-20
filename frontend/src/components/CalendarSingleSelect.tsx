import * as React from "react"
import { Check, ChevronsUpDown, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command"
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover"

interface CalendarInfo {
    id: string
    name: string
}

interface CalendarSingleSelectProps {
    // The selected calendar id. "" means the explicit "none" option is selected.
    value: string
    onChange: (value: string) => void
    available: CalendarInfo[]
    placeholder?: string
    // Label for the built-in "clear selection" row (value ""). Omit to hide it.
    noneLabel?: string
}

// Single-calendar picker, the counterpart to CalendarMultiSelect. Used for the
// fixed host calendar, where exactly one calendar (or none) is chosen. Supports
// picking from the owner's calendar list or adding a calendar by email address.
export function CalendarSingleSelect({
    value,
    onChange,
    available,
    placeholder = "Select a calendar...",
    noneLabel,
}: CalendarSingleSelectProps) {
    const [open, setOpen] = React.useState(false)
    const [searchValue, setSearchValue] = React.useState("")

    // A value set to a calendar not in `available` (e.g. one added by email) is
    // still shown as an option so it renders with a checkmark and a label.
    const availableIds = new Set(available.map((c) => c.id))
    const extra = value && !availableIds.has(value) ? [{ id: value, name: value }] : []
    const allOptions = [...available, ...extra]
    const selectedCal = allOptions.find((c) => c.id === value)

    const handleSelect = (id: string) => {
        onChange(id)
        setOpen(false)
    }

    const handleAddCustom = () => {
        if (searchValue && searchValue.includes("@")) {
            onChange(searchValue)
            setSearchValue("")
            setOpen(false)
        }
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    className="w-full justify-between h-auto min-h-10 py-2 font-normal"
                >
                    <span className={cn("text-left truncate", !value && "text-muted-foreground")}>
                        {value ? (selectedCal?.name || value) : placeholder}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[400px] p-0" align="start">
                <Command>
                    <CommandInput
                        placeholder="Search or add calendar email..."
                        value={searchValue}
                        onValueChange={setSearchValue}
                    />
                    <CommandList>
                        <CommandEmpty>
                            <div className="p-2 flex flex-col items-center justify-center gap-2">
                                <span className="text-muted-foreground text-sm">No calendar found.</span>
                                {searchValue && searchValue.includes("@") && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="w-full"
                                        onClick={handleAddCustom}
                                    >
                                        <Plus className="mr-2 h-4 w-4" />
                                        Add "{searchValue}"
                                    </Button>
                                )}
                            </div>
                        </CommandEmpty>
                        <CommandGroup heading="Calendars">
                            {noneLabel && (
                                <CommandItem
                                    key="__none__"
                                    value="__none__"
                                    onSelect={() => handleSelect("")}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            value === "" ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    <span className="text-muted-foreground">{noneLabel}</span>
                                </CommandItem>
                            )}
                            {allOptions.map((calendar) => (
                                <CommandItem
                                    key={calendar.id}
                                    value={calendar.id + " " + calendar.name} // Include name in value for fuzzy search
                                    onSelect={() => handleSelect(calendar.id)}
                                >
                                    <Check
                                        className={cn(
                                            "mr-2 h-4 w-4",
                                            value === calendar.id ? "opacity-100" : "opacity-0"
                                        )}
                                    />
                                    <div className="flex flex-col">
                                        <span>{calendar.name}</span>
                                        <span className="text-xs text-muted-foreground">{calendar.id}</span>
                                    </div>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    )
}
