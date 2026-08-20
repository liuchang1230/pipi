import { memo, useEffect, useMemo, useRef } from "react";
import { filterFileMentions, type FileMention } from "../file-mentions";
import { Icon } from "./Icon";

interface FileMentionMenuProps {
  files: FileMention[];
  query: string;
  selectedIndex: number;
  loading: boolean;
  onSelect: (file: FileMention) => void;
  onHover: (index: number) => void;
}

export const FileMentionMenu = memo(function FileMentionMenu({
  files, query, selectedIndex, loading, onSelect, onHover,
}: FileMentionMenuProps) {
  const list = useMemo(() => filterFileMentions(files, query), [files, query]);
  const selRef = useRef<HTMLDivElement>(null);
  useEffect(() => { selRef.current?.scrollIntoView({ block: "nearest" }); }, [selectedIndex, query]);
  return (
    <div className="file-mention-menu">
      <div className="slash-menu-title">
        {loading ? "正在搜索项目文件…" : query ? `“@${query}” 匹配 ${list.length} 个文件` : `${files.length} 个项目文件`}
      </div>
      {!loading && list.length === 0 ? (
        <div className="slash-menu-empty">无匹配文件</div>
      ) : (
        list.map((file, i) => (
          <div
            key={`${file.type}:${file.path}`}
            ref={i === selectedIndex ? selRef : undefined}
            className={`slash-menu-item${i === selectedIndex ? " selected" : ""}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(file); }}
          >
            <span className="slash-menu-icon"><Icon name={file.type === "directory" ? "folder" : "file"} /></span>
            <span className="slash-menu-name">@{file.path}</span>
            <span className="slash-menu-desc">{file.type === "directory" ? "目录" : "文件"}</span>
          </div>
        ))
      )}
    </div>
  );
});
