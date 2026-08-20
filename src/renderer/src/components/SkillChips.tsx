/**
 * SkillChips: the session's discovered skills as click-to-insert chips above
 * the chat input (source: "skill" entries from get_commands, e.g.
 * "/skill:brave-search"). Clicking inserts "/skill:name " into the input.
 */
import { memo } from "react";
import { sourceIcon, type SessionCommand } from "../commands";
import { Icon } from "./Icon";

interface SkillChipsProps {
  skills: SessionCommand[];
  onInsert: (commandName: string) => void;
}

export const SkillChips = memo(function SkillChips({ skills, onInsert }: SkillChipsProps) {
  if (skills.length === 0) return null;
  return (
    <div className="skill-chips">
      {skills.map((s) => (
        <button
          key={s.name}
          className="skill-chip"
          title={s.description ?? s.path ?? s.name}
          onMouseDown={(e) => {
            e.preventDefault();
            onInsert(s.name);
          }}
        >
          <Icon name={sourceIcon(s.source)} /> {s.name}
        </button>
      ))}
    </div>
  );
});
