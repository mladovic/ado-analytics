import * as React from "react";
import { Sun, Moon } from "lucide-react";
import { useTheme, Theme } from "remix-themes";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

interface ModeToggleProps extends React.ComponentProps<"button"> {}

export const ModeToggle: React.FC<ModeToggleProps> = ({
  className,
  ...props
}) => {
  const [theme, setTheme] = useTheme();
  const isDark = theme === Theme.DARK;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      className={cn("h-9 w-9", className)}
      onClick={() => setTheme(isDark ? Theme.LIGHT : Theme.DARK)}
      {...props}
    >
      {isDark ? <Moon className="size-5" /> : <Sun className="size-5" />}
    </Button>
  );
};
