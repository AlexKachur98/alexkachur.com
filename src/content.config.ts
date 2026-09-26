import { defineCollection, reference } from 'astro:content';
import { file, glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { pageContent, photo, projectContent, screenshot, technologyContent } from './content/schemas.ts';

const projects = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/projects' }),
  schema: ({ image }) =>
    projectContent.extend({
      technologies: z.array(reference('technologies')).describe(projectContent.shape.technologies.description ?? ''),
      screenshots: z
        .array(screenshot.extend({ src: image().describe(screenshot.shape.src.description ?? '') }))
        .describe(projectContent.shape.screenshots.description ?? ''),
    }),
});

const technologies = defineCollection({
  loader: file('src/content/technologies.yaml'),
  schema: technologyContent,
});

const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/pages' }),
  schema: ({ image }) =>
    pageContent.extend({
      images: z
        .array(photo.extend({ src: image().describe(photo.shape.src.description ?? '') }))
        .optional()
        .describe(pageContent.shape.images.description ?? ''),
    }),
});

export const collections = { projects, technologies, pages };
