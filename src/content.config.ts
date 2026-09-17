import { defineCollection, reference } from 'astro:content';
import { file, glob } from 'astro/loaders';
import { z } from 'astro/zod';
import {
  courseContent,
  factContent,
  pageContent,
  petContent,
  projectContent,
  screenshot,
  technologyContent,
  timelineContent,
} from './content/schemas.ts';

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

const courses = defineCollection({
  loader: file('src/content/courses.yaml'),
  schema: courseContent,
});

const timeline = defineCollection({
  loader: file('src/content/timeline.yaml'),
  schema: timelineContent,
});

const pets = defineCollection({
  loader: file('src/content/pets.yaml'),
  schema: petContent,
});

const facts = defineCollection({
  loader: file('src/content/facts.yaml'),
  schema: factContent,
});

const pages = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/pages' }),
  schema: pageContent,
});

export const collections = { projects, technologies, courses, timeline, pets, facts, pages };
