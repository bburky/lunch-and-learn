import fm from "front-matter"
import fs from "node:fs"
import { glob } from "glob"
import hbs from "handlebars"
import path from "path"
import pc from "picocolors"
import { exit } from "process"
import { Env, md, slugify } from "./md"
import esbuild from "esbuild"
import rt from "reading-time"

export interface CustomFrontmatter {
  title: string
  slug: string
  layout: "default" | "slides"
}

type LastModified = {
  filepath: string
  then: number
  by: string
  createdAt: number
}

async function main() {
  const { stdout } = Bun.spawn(["node", "generator/timestamps.mjs"])
  const lm: LastModified[] = await new Response(stdout).json()

  const partials = glob.sync("templates/partials/*.hbs")
  for (const filepath of partials) {
    const name = path.basename(filepath, ".hbs")
    const partial = hbs.compile(fs.readFileSync(filepath, "utf-8"))
    hbs.registerPartial(name, partial)
  }
  const template = hbs.compile(fs.readFileSync("templates/layout.hbs", "utf-8"))
  hbs.registerHelper("ifEquals", function (arg1, arg2, options) {
    // @ts-expect-error "this" is implicitly any because of the way handlebars works
    return arg1 === arg2 ? options.fn(this) : options.inverse(this)
  })

  const files = glob.sync(path.join("content", "*.md"))

  if (files.length === 0) {
    console.log(pc.blue("No files found"))
    exit(1)
  }
  fs.rmSync("public", { recursive: true, force: true })
  fs.mkdirSync("public", { recursive: true })

  // copy everything in static to public
  for (const filepath of glob.sync("static/**/*")) {
    const dst = path.join("public", path.relative("static", filepath))
    if (fs.lstatSync(filepath).isDirectory()) {
      fs.mkdirSync(dst)
      continue
    }
    fs.copyFileSync(filepath, dst)
  }

  // bundle the index.ts and reveal.ts entrypoints
  await esbuild.build({
    entryPoints: ["templates/index.ts", "templates/reveal.ts"],
    format: "esm",
    bundle: true,
    outdir: "public",
    minify: true,
    sourcemap: true,
    target: "esnext",
    platform: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  })

  // build the routes
  const routes = lm
    .sort((a, b) => {
      // ensure content/_index.md is always first
      if (a.filepath === path.join("content", "_index.md")) {
        return -1
      }
      return a.createdAt - b.createdAt
    })
    .map((t) => {
      const fileContent = fs.readFileSync(t.filepath, "utf-8")
      const content = fm(fileContent)
      const attributes = content.attributes as CustomFrontmatter
      if (attributes.slug === "index") {
        attributes.slug = ""
      }
      return attributes
    })

  const slugs = new Set<string>()

  for (const filepath of files) {
    const fileContent = fs.readFileSync(filepath, "utf-8")
    const ts = lm.find((t) => t.filepath === filepath)

    const content = fm(fileContent)
    const attributes = content.attributes as CustomFrontmatter

    if (!attributes.title) {
      throw new Error(`Missing title in ${filepath}`)
    }
    if (!attributes.slug) {
      throw new Error(`Missing slug in ${filepath}`)
    }
    attributes.slug = slugify(attributes.slug)
    if (slugs.has(attributes.slug)) {
      throw new Error(`Duplicate slug ${attributes.slug} in ${filepath}`)
    }
    slugs.add(attributes.slug)

    let result = ""
    const meta = {
      ...attributes,
      routes,
      ...ts,
    }

    if (!attributes.layout || attributes.layout === "default") {
      const env: Env = {}
      const html = md.render(content.body, env)

      result = template({
        ...meta,
        body: html,
        toc: env.headers,
        readingTime: rt(content.body).text,
      })
    } else if (attributes.layout === "slides") {
      result = template({
        ...meta,
        body: content.body,
      })
    } else {
      throw new Error(`Unknown layout ${attributes.layout} in ${filepath}`)
    }

    if (attributes.slug === "index") {
      fs.writeFileSync(path.join("public", "index.html"), result)
      continue
    }

    const routeDir = path.join("public", attributes.slug)

    fs.mkdirSync(routeDir)

    fs.writeFileSync(path.join(routeDir, "index.html"), result)
  }
}

if (import.meta.main) {
  await main()
}