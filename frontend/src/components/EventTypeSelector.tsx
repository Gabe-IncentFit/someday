import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { EventType } from "@/models/EventType";
import { Clock, Settings } from "lucide-react";

interface EventTypeSelectorProps {
    eventTypes: EventType[];
    onSelect: (et: EventType) => void;
    onOpenConfig?: () => void;
}

export function EventTypeSelector({ eventTypes, onSelect, onOpenConfig }: EventTypeSelectorProps) {
    // With nothing to list there are no event-type cards, and the heading and
    // message were the whole widget — bare text with no surface behind it. It
    // carries its own card so the empty state still reads as the same component
    // as every other state, rather than as text spilled onto the host's page.
    if (eventTypes.length === 0) {
        return (
            <Card className="w-full max-w-[600px] mx-auto min-h-[400px] relative flex flex-col items-center justify-center gap-3 p-6 text-center">
                {onOpenConfig && (
                    <Button
                        variant="outline"
                        size="icon"
                        className="absolute right-4 top-4"
                        onClick={onOpenConfig}
                    >
                        <Settings className="h-4 w-4" />
                    </Button>
                )}
                <h1 className="text-2xl font-bold">Nothing to book right now</h1>
                <p className="text-sm text-muted-foreground max-w-sm">
                    There are no appointment types available on this page.
                    {/* Only the owner gets onOpenConfig, so this hint stays private. */}
                    {onOpenConfig && " Enable one under Settings, or share a direct link."}
                </p>
            </Card>
        );
    }

    return (
        <div className="w-full max-w-[600px] mx-auto space-y-4 relative">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold">Select Appointment Type</h1>
                {onOpenConfig && (
                    <Button variant="outline" size="icon" onClick={onOpenConfig}>
                        <Settings className="h-4 w-4" />
                    </Button>
                )}
            </div>

            <div className="grid grid-cols-1 gap-4">
                {eventTypes.map((et) => (
                    <Card key={et.id} className="hover:border-primary cursor-pointer transition-colors" onClick={() => onSelect(et)}>
                        <CardHeader>
                            <CardTitle>{et.name}</CardTitle>
                            {et.description && <CardDescription>{et.description}</CardDescription>}
                        </CardHeader>
                        <CardContent>
                            <div className="flex items-center text-sm text-muted-foreground">
                                <Clock className="mr-2 h-4 w-4" />
                                {et.duration} minutes
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}
