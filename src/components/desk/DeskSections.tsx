import { Fragment, type ReactNode } from "react";
import { deskSectionsOrDefault, type DeskSectionId } from "@shared/workspace-tabs";

/** Renders Desk content sections in the saved order, skipping hidden ones.
 * An absent or invalid layout renders today's order. Needs you always shows. */
export function DeskSections({ sections, render }: { sections: unknown; render: Record<DeskSectionId, ReactNode> }) {
  return (
    <>
      {deskSectionsOrDefault(sections).map(section =>
        section.visible || section.id === "queue" ? <Fragment key={section.id}>{render[section.id]}</Fragment> : null,
      )}
    </>
  );
}
