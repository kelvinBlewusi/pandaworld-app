"use client";

import { useState, useCallback } from "react";
import { Upload, X, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  preview: string;
}

interface ImageUploadDropzoneProps {
  onFilesChange?: (files: UploadedFile[]) => void;
  maxFiles?: number;
  className?: string;
}

export function ImageUploadDropzone({
  onFilesChange,
  maxFiles = 10,
  className,
}: ImageUploadDropzoneProps) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const addFiles = useCallback(
    (newFileList: FileList) => {
      const newFiles: UploadedFile[] = Array.from(newFileList)
        .slice(0, maxFiles - files.length)
        .map((file) => ({
          id: Math.random().toString(36).slice(2),
          name: file.name,
          size: file.size,
          preview: URL.createObjectURL(file),
        }));
      const updated = [...files, ...newFiles];
      setFiles(updated);
      onFilesChange?.(updated);
    },
    [files, maxFiles, onFilesChange]
  );

  const removeFile = (id: string) => {
    const updated = files.filter((f) => f.id !== id);
    setFiles(updated);
    onFilesChange?.(updated);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) addFiles(e.target.files);
  };

  return (
    <div className={cn("space-y-4", className)}>
      <label
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-all duration-200",
          isDragging
            ? "border-blue-400 bg-blue-50"
            : "border-zinc-200 bg-zinc-50/50 hover:border-zinc-300 hover:bg-zinc-50"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          accept="image/jpeg,image/png"
          multiple
          className="sr-only"
          onChange={handleInput}
        />
        <div
          className={cn(
            "rounded-full p-3 transition-colors",
            isDragging ? "bg-blue-100 text-blue-500" : "bg-zinc-100 text-zinc-400"
          )}
        >
          <Upload className="h-6 w-6" />
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-700">
            Drop your product photos here
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            or click to browse — JPG, PNG, WEBP up to 10MB each
          </p>
          <p className="mt-1 text-xs text-zinc-400">
            Up to {maxFiles} images per listing
          </p>
        </div>
      </label>

      {files.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {files.map((file) => (
            <div
              key={file.id}
              className="group relative aspect-square overflow-hidden rounded-xl border bg-zinc-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.preview}
                alt={file.name}
                className="h-full w-full object-cover"
              />
              <button
                onClick={() => removeFile(file.id)}
                className="absolute right-1.5 top-1.5 rounded-full bg-black/50 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/40 p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <p className="truncate text-[10px] text-white">{file.name}</p>
              </div>
            </div>
          ))}
          {files.length < maxFiles && (
            <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-zinc-200 text-zinc-400 transition-colors hover:border-zinc-300 hover:text-zinc-500">
              <input
                type="file"
                accept="image/jpeg,image/png"
                multiple
                className="sr-only"
                onChange={handleInput}
              />
              <ImageIcon className="h-5 w-5" />
              <span className="text-[10px] font-medium">Add more</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
