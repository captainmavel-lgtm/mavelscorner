module.exports = function(eleventyConfig) {

  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/_redirects");
  eleventyConfig.addPassthroughCopy("src/assets/css");
  eleventyConfig.addPassthroughCopy("src/assets/js");

  eleventyConfig.addFilter("readableDate", (dateObj) => {
    const d = new Date(dateObj);
    return d.toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric"
    });
  });
  
  eleventyConfig.addFilter("skip", (array, n) => array.slice(n));
  eleventyConfig.addFilter("truncate", (str, len) =>
    str && str.length > len ? str.slice(0, len) + "…" : str
  );

  eleventyConfig.addCollection("event", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/_events/*.md");
  });

  eleventyConfig.addCollection("ebook", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/_ebooks/*.md");
  });

  eleventyConfig.addCollection("quote", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/_quotes/*.md");
  });

  eleventyConfig.addCollection("devotional", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/_devotionals/*.md");
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
};
